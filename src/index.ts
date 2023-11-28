import express from 'express';
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
  let code = 0,
    stdout = '',
    stderr = '';
  spawnStream.stdout.on('data', (data) => {
    log(`[${baseCmd}/stdout]: ${data}`);
    stdout += data;
  });
  spawnStream.stderr.on('data', (data) => {
    log(`[${baseCmd}/stderr]: ${data}`);
    stderr += data;
  });
  spawnStream.on('close', (rc: number) => {
    log(`[${baseCmd}/close]: ${code}`);
    code = rc;
  });
  if (!noWait) await once(spawnStream, 'close');
  return { code, stdout, stderr, spawnStream };
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

// Helper function to get application release id
const getReleaseId = async (slug: string, token: string) =>
  (
    await apiGet(
      `application?$select=should_be_running__release/id&$filter=slug%20eq%20%27${slug}%27`,
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
      `image?$select=is_stored_at__image_location,is_a_build_of__service/id&$filter=id%20in%20(${imageIds})`,
      token
    )) ?? []
  ).map((x: any) => ({
    imageLocation: x.is_stored_at__image_location,
    serviceId: x.id,
  })) as { imageLocation: string; serviceId: number }[];
};

// Helper function to determine which images to generate deltas for
const generateDeltas = async (
  oldReleaseId: number,
  newReleaseId: number,
  token: string
) => {
  const oldImages = await getImages(oldReleaseId, token);
  const newImages = await getImages(newReleaseId, token);
  const deltas: { src: string; dest: string }[] = [];
  newImages.forEach((newImage) => {
    const match = oldImages.find(
      (oldImage) =>
        oldImage.serviceId === newImage.serviceId &&
        oldImage.imageLocation !== newImage.imageLocation
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
    let workdir;

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
      if (isdraft) throw new Error('draft builds are not yet supported');

      // Make sure we have a builder
      if (dockerHostAmd64 === '' && dockerHostArm64 === '')
        throw new Error('no builder available');

      // Set up workdir
      const uuid = crypto.randomUUID();
      workdir = `/tmp/${uuid}`;
      fs.mkdirSync(workdir);

      // Extract tar stream to workdir
      if (!req.query.test) {
        req.pipe(tar.x({ cwd: workdir }));
        await once(req, 'end');
      }

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

      // Get previous release images
      const oldReleaseId = await getReleaseId(String(slug), token);

      // Build image and return stream
      const { spawnStream } = await exec(
        [
          req.query.test ? 'echo' : '/usr/local/bin/balena',
          'deploy',
          String(slug),
          '--build',
          emulated === 'true' ? '--emulated' : '',
          nocache === 'true' ? '--nocache' : '',
          dockerfilePath !== '' ? `--dockerfile=${dockerfilePath}` : '',
        ],
        workdir,
        envAdd,
        true
      );

      // Only wait for output when headless is false (default)
      if (headless === 'false' && !req.query.test) {
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

        // Create transformers for stdout/stderr feeds to be handled by balena-cli
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
                replace:
                  message.includes('\u001b[2K\r') || !message.includes('\n'),
              },
            })
          );
          callback();
        };

        const outTransform = new stream.Transform();
        outTransform._transform = transform;
        const errTransform = new stream.Transform();
        errTransform._transform = transform;

        // Pipe output through transformers to balena-cli
        spawnStream.stdout.pipe(outTransform).pipe(res);
        spawnStream.stderr.pipe(errTransform).pipe(res);
      } else {
        res.status(200).send('Build started');
        headlessReturned = true;
      }

      // Wait for build to finish
      await once(spawnStream, 'close');

      // Get previous release images
      const newReleaseId = await getReleaseId(String(slug), token);
      const deltas = await generateDeltas(
        req.query.test ? oldReleaseId - 1 : oldReleaseId,
        newReleaseId,
        token
      );
      for (let i = 0; i < deltas.length; i++) {
        const delta = deltas[i];
        log(`Generating delta for ${delta.src} to ${delta.dest}`);
        // Get registry token for delta process
        const registry = delta.src.split('/')[0];
        const deltaToken = (
          await axios.get(
            `https://${apiHost}/auth/v1/token?service=${registry}&scope=repository:${delta.src}:pull&scope=repository:${delta.dest}:pull`,
            { auth: { username: 'builder', password: builderToken } }
          )
        ).data?.token;
        // Generate delta
        const deltaName = (
          await axios.get(
            `https://${deltaHost}/api/v3/delta?src=${delta.src}&dest=${delta.dest}&wait=true`,
            { headers: { Authorization: `Bearer ${deltaToken}` } }
          )
        )?.data?.name;
        log(`Successfully generated delta: ${deltaName}`);
      }

      // Delete images or tag images and keep?
    } catch (err) {
      log(`Error: ${err.message}`);
      if (!headlessReturned) res.status(400).send(err.message);
    }

    // Delete build directory and all contents
    if (workdir && fs.existsSync(workdir))
      fs.rmSync(workdir, { recursive: true });
  });

  app.listen(listenPort, () => {
    console.log(`Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
