import express, { Response } from 'express';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';
import * as stream from 'stream';
import axios from 'axios';
import * as tar from 'tar';

const PORT = 80;
const DEBUG = true;

// Pull environment variables
const balenaTld = String(process.env.BALENA_TLD);
const apiHost = String(process.env.API_HOST ?? `api.${balenaTld}`);
const deltaHost = String(process.env.DELTA_HOST ?? `delta.${balenaTld}`);
const dockerHostAmd64 = String(process.env.DOCKER_HOST_AMD64 ?? '');
const dockerHostArm64 = String(process.env.DOCKER_HOST_ARM64 ?? '');
const builderToken = String(process.env.TOKEN_AUTH_BUILDER_TOKEN);

// Debug healper function
const log = (msg: string) => {
  if (DEBUG) console.log(`[open-balena-builder] ${msg}`);
};

// Spinner helper functions inspired by balena-cli release spinner
function createRunLoop(tick: (...args: any[]) => void) {
  const timerId = setInterval(tick, 1000 / 10);
  const runloop = {
    onEnd() {
      // noop
    },
    end() {
      clearInterval(timerId);
      return runloop.onEnd();
    },
  };
  return runloop;
}

function createSpinner() {
  const chars = '|/-\\';
  let index = 0;
  return () => chars[index++ % chars.length];
}

async function runSpinner<T>(
  res: Response,
  spinner: () => string,
  msg: string,
  fn: () => Promise<T>
): Promise<T> {
  const writeLine = (str: string, replace: boolean) =>
    res.write(JSON.stringify({ message: { message: str, replace } }));
  const clearLine = () =>
    res.write(JSON.stringify({ message: { message: '', replace: true } }));
  const runloop = createRunLoop(function () {
    clearLine();
    writeLine(`${msg} ${spinner()}`, true);
  });
  runloop.onEnd = function () {
    clearLine();
    writeLine(msg, false);
  };
  try {
    return await fn();
  } finally {
    runloop.end();
  }
}

// Stream transformer for stdout/stderr feeds to be handled by balena-cli
const transform = function (
  chunk: Buffer,
  _encoding: BufferEncoding,
  callback: stream.TransformCallback
) {
  const message = chunk.toString();
  this.push(
    JSON.stringify({
      message: {
        message,
        isError: message.includes('[Error]'),
        replace: message.includes('\u001b[2K\r') || !message.includes('\n'),
      },
    })
  );
  callback();
};

// Helper function to execute shell commands
const exec = async (
  cmd: string[],
  cwd: string,
  envAdd?: any,
  noWait?: boolean
) => {
  // remove any empty parameters
  cmd = cmd.filter((x) => x?.length > 0);
  log(`Executing command: ${cmd}`);

  // set up execution environment
  const env = {
    BALENARC_BALENA_URL: balenaTld,
    BALENARC_DATA_DIRECTORY: cwd,
    DOCKER_CONFIG: `${cwd}/.docker`,
    DOCKER_BUILDKIT: '0',
    ...(envAdd ?? {}),
  };

  // split base command from args
  const baseCmd = cmd[0];
  const args = cmd.slice(1);

  const spawnStream = spawn(baseCmd, args, { cwd, env });
  let code;
  spawnStream.stdout.on('data', (data) =>
    data
      .toString()
      .split(/\r\n|\n|\r/)
      .forEach((line: string) => {
        line = line.replace(/[^ -~]+/g, '').replace(/\[.{0,3}[KAHmlh]$/g, '');
        if (line.trim().length > 0) log(`[${baseCmd}/stdout]: ${line}`);
      })
  );
  spawnStream.stderr.on('data', (data) =>
    data
      .toString()
      .split(/\r\n|\n|\r/)
      .forEach((line: string) => {
        line = line.replace(/[^ -~]+/g, '').replace(/\[.{0,3}[KAHmlh]$/g, '');
        if (line.trim().length > 0) log(`[${baseCmd}/stderr]: ${line}`);
      })
  );
  spawnStream.on('close', (rc: number) => {
    log(`[${baseCmd}/close]: ${rc}`);
    code = rc;
  });
  if (!noWait) await once(spawnStream, 'close');
  return { code, spawnStream };
};

// Helper function to get data from open-balena-api
const apiGet = async (path: string, token: string) =>
  (
    await axios.get(`https://${apiHost}/v6/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
  )?.data?.d;

// Helper function to get application architecture
const getArch = async (slug: string, token: string) =>
  (
    await apiGet(
      `cpu_architecture?$select=slug&$filter=is_supported_by__device_type/any(dt:dt/is_default_for__application/any(a:a/slug%20eq%20%27${slug}%27))`,
      token
    )
  )?.[0]?.slug;

// Helper function to get active release id for application
const getReleaseIdForApp = async (slug: string, token: string) =>
  (
    await apiGet(
      `application?$select=should_be_running__release/id&$filter=slug%20eq%20%27${slug}%27`,
      token
    )
  )?.[0]?.id;

// Helper function to get release id from commit
const getReleaseIdFromCommit = async (commit: string, token: string) =>
  (
    await apiGet(
      `release?$select=id&$filter=commit%20eq%20%27${commit}%27`,
      token
    )
  )?.[0]?.id;

// Helper function to get image locations from release id
const getImages = async (releaseId: number, token: string) => {
  const imageIds = (
    await apiGet(
      `release_image?$select=image/id&$filter=is_part_of__release/any(r:r/id%20eq%20${releaseId})`,
      token
    )
  )
    ?.map((x: any) => x?.id ?? '')
    .join(',');
  return (
    (await apiGet(
      `image?$select=is_stored_at__image_location,content_hash,is_a_build_of__service/id&$filter=id%20in%20(${imageIds})`,
      token
    )) ?? []
  ).map((x: any) => ({
    imageLocation: x.is_stored_at__image_location,
    contentHash: x.content_hash,
    serviceId: x.id,
  })) as { imageLocation: string; contentHash: string; serviceId: number }[];
};

// Helper function to determine which images to generate deltas for
const generateDeltas = async (oldId: number, newId: number, token: string) => {
  const oldImages = await getImages(oldId, token);
  const newImages = await getImages(newId, token);
  const deltas: { src: string; dest: string }[] = [];
  newImages.forEach((newImage) => {
    const match = oldImages.find(
      (oldImage) =>
        oldImage.serviceId === newImage.serviceId &&
        oldImage.imageLocation !== newImage.imageLocation &&
        oldImage.contentHash !== newImage.contentHash
    );
    if (match)
      deltas.push({
        src: match.imageLocation,
        dest: newImage.imageLocation,
      });
  });
  return deltas;
};

async function createHttpServer(listenPort: number) {
  const app = express();

  app.post('/v3/build', async (req, res) => {
    // Set up build environment
    let workdir = '';

    let headlessReturned = false;

    try {
      const { slug, dockerfilePath, nocache, headless, isdraft } = req.query;
      let { emulated } = req.query;
      const token = req.headers.authorization?.split(' ')?.[1];

      log(
        `Build request received: ${JSON.stringify({
          query: req.query,
          headers: req.headers,
        })}`
      );
      if (!slug) throw new Error('app slug must be specified');
      if (!token) throw new Error('authorization header must be provided');

      // Make sure we have a builder
      if (dockerHostAmd64 === '' && dockerHostArm64 === '')
        throw new Error('no builder available');

      // Set up workdir
      const uuid = crypto.randomUUID();
      workdir = `/tmp/${uuid}`;
      fs.mkdirSync(workdir);

      // Extract tar stream to workdir
      req.pipe(tar.x({ cwd: workdir }));
      await once(req, 'end');

      // Authenticate with openbalena
      await exec(['/usr/local/bin/balena', 'login', '-t', token], workdir);

      // Get application architecture
      const arch = await getArch(String(slug), token);

      // Try to find native docker builder, otherwise run emulated build
      const envAdd: any = {};
      if (
        ['amd64', 'i386', 'i386-nlp'].includes(arch) &&
        dockerHostAmd64 !== ''
      ) {
        log(`Using native amd64 builder to build ${arch} image`);
        envAdd.DOCKER_HOST = dockerHostAmd64;
      } else if (
        ['aarch64', 'armv7hf', 'rpi'].includes(arch) &&
        dockerHostArm64 !== ''
      ) {
        log(`Using native arm64 builder to build ${arch} image`);
        envAdd.DOCKER_HOST = dockerHostArm64;
      } else {
        emulated = 'true';
        if (dockerHostAmd64 !== '') {
          log(
            `No native builder avialable to build ${arch} image; running emulated build on amd64 builder`
          );
          envAdd.DOCKER_HOST = dockerHostAmd64;
        } else {
          log(
            `No native builder avialable for ${arch}; running emulated build on arm64 builder`
          );
          envAdd.DOCKER_HOST = dockerHostArm64;
        }
      }

      // Build image, deploy as draft release, and return stream
      const { spawnStream } = await exec(
        [
          '/usr/local/bin/balena',
          'deploy',
          String(slug),
          '--build',
          '--draft',
          emulated === 'true' ? '--emulated' : '',
          nocache === 'true' ? '--nocache' : '',
          dockerfilePath !== '' ? `--dockerfile=${dockerfilePath}` : '',
        ],
        workdir,
        envAdd,
        true
      );

      let newCommit = '';

      spawnStream.stdout.on('data', (data) => {
        data
          .toString()
          .split(/\r\n|\n|\r/)
          .forEach((line: string) => {
            line = line
              .replace(/[^ -~]+/g, '')
              .replace(/\[.{0,3}[KAHmlh]$/g, '')
              .trim();
            const match = /\[Success\] Release: ([0-9a-f]+).*$/.exec(line);
            if (match) {
              newCommit = match[1];
              log(`Parsed release commit: ${newCommit}`);
            }
          });
      });

      // Only wait for output when headless is false (default)
      if (headless === 'false') {
        // Detect abort by client (response closure) and kill build if received
        let finished = false;
        spawnStream.on('close', () => {
          finished = true;
        });
        res.on('close', () => {
          if (!finished) {
            log('Build request aborted by client');
            spawnStream.kill();
          }
        });

        const outTransform = new stream.Transform();
        outTransform._transform = transform;
        const errTransform = new stream.Transform();
        errTransform._transform = transform;

        // Pipe output through transformers to balena-cli
        spawnStream.stdout.pipe(outTransform).pipe(res, { end: false });
        spawnStream.stderr.pipe(errTransform).pipe(res, { end: false });
      } else {
        res.status(200).send('Build started');
        headlessReturned = true;
      }

      // Wait for build to finish
      await once(spawnStream, 'close');

      if (newCommit === '') throw new Error('Build error');

      // Get previous release images
      const oldReleaseId = await getReleaseIdForApp(String(slug), token);
      const newReleaseId = await getReleaseIdFromCommit(newCommit, token);
      const deltas = await generateDeltas(oldReleaseId, newReleaseId, token);

      const spinner = createSpinner();

      await runSpinner(res, spinner, `[Delta] Creating image deltas...`, () =>
        Promise.all(
          deltas.map(async (delta) => {
            log(`Generating delta for ${delta.src} to ${delta.dest}`);
            const registry = delta.src.split('/')[0];
            const deltaToken = (
              await axios.get(
                `https://${apiHost}/auth/v1/token?service=${registry}&scope=repository:${delta.src}:pull&scope=repository:${delta.dest}:pull`,
                { auth: { username: 'builder', password: builderToken } }
              )
            )?.data?.token;
            return axios
              .get(
                `https://${deltaHost}/api/v3/delta?src=${delta.src}&dest=${delta.dest}&wait=true`,
                { headers: { Authorization: `Bearer ${deltaToken}` } }
              )
              .then(({ data }) =>
                log(`Successfully generated delta: ${data?.name}`)
              );
          })
        )
      );

      if (isdraft === 'false') {
        log('Finalizing release');

        const releaseCode = (
          await runSpinner(
            res,
            spinner,
            `[Release] Finalizing Release...`,
            () =>
              exec(
                ['/usr/local/bin/balena', 'release', 'finalize', newCommit],
                workdir,
                envAdd,
                false
              )
          )
        ).code;

        if (releaseCode === 0) {
          log('Successfully finalized release');
          const message = '[Success] Release finalized!';
          res.write(JSON.stringify({ message: { message } }));
        } else throw new Error('Failed to finalize release');
      }

      // Delete images or tag images and keep?
    } catch (err) {
      log(`Error: ${err.message}`);
      if (!headlessReturned) res.status(400).send(err.message);
    }

    // Delete build directory and all contents
    if (workdir != '' && fs.existsSync(workdir))
      fs.rmSync(workdir, { recursive: true });

    // Close response
    res.end();
  });

  app.listen(listenPort, () => {
    log(`Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
