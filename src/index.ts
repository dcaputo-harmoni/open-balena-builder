import * as express from 'express';
import * as fs from 'fs';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';
import * as stream from 'stream';
import axios from 'axios';

const PORT = 80;
const DEBUG = true;

// Pull environment variables
const balenaTld = String(process.env.BALENA_TLD);
const apiHost = String(process.env.API_HOST ?? `api.${balenaTld}`);
const dockerHostAmd64 = String(process.env.DOCKER_HOST_AMD64 ?? '');
const dockerHostArm64 = String(process.env.DOCKER_HOST_ARM64 ?? '');

const exec = async (
  cmd: string[],
  cwd: string,
  envAdd?: any,
  noWait?: boolean
) => {
  // remove any empty parameters
  cmd = cmd.filter((x) => x?.length > 0);
  if (DEBUG) console.log(`[open-balena-builder] Executing command: ${cmd}`);

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
    if (DEBUG)
      console.log(`[open-balena-builder] [${baseCmd}/stdout]: ${data}`);
    stdout += data;
  });
  spawnStream.stderr.on('data', (data) => {
    if (DEBUG)
      console.log(`[open-balena-builder] [${baseCmd}/stderr]: ${data}`);
    stderr += data;
  });
  spawnStream.on('close', (rc: number) => {
    if (DEBUG) console.log(`[open-balena-builder] [${baseCmd}/close]: ${code}`);
    code = rc;
  });
  if (!noWait) await once(spawnStream, 'close');
  return { code, stdout, stderr, spawnStream };
};

async function createHttpServer(listenPort: number) {
  const app = express();

  app.post('/v3/build', async (req, res) => {
    // Set up build environment
    let workdir;

    try {
      const { slug, dockerfilePath, nocache, headless, isdraft } = req.query;
      let { emulated } = req.query;
      const jwt = req.headers.authorization?.split(' ')?.[1];
      if (DEBUG)
        console.log(
          `[open-balena-builder] Build request received: ${JSON.stringify({
            slug,
            dockerfilePath,
            emulated,
            nocache,
            headless,
            isdraft,
            jwt,
          })}`
        );
      if (!slug) throw new Error('app slug must be specified');
      if (!jwt) throw new Error('authorization header must be provided');

      // Make sure we have a builder
      if (dockerHostAmd64 === '' && dockerHostArm64 === '')
        throw new Error('no builder available');

      // Set up workdir
      const uuid = crypto.randomUUID();
      workdir = `/tmp/${uuid}`;
      fs.mkdirSync(workdir);

      // Save tar file to workdir
      const filestream = fs.createWriteStream(`${workdir}/build.tar`);
      req.pipe(filestream);
      await once(req, 'end');
      filestream.close();

      // Extract tar archive
      await exec(['tar', 'xf', `${workdir}/build.tar`], workdir);

      // Authenticate with openbalena
      await exec(['/usr/local/bin/balena', 'login', '-t', jwt], workdir);

      // Get application architecture
      const arch = (
        await axios.get(
          `https://${apiHost}/v6/cpu_architecture?$select=slug&$filter=is_supported_by__device_type/any(dt:dt/is_default_for__application/any(a:a/slug%20eq%20%27${slug}%27))`,
          {
            headers: {
              Authorization: `Bearer ${jwt}`,
            },
          }
        )
      )?.data?.d?.[0]?.slug;

      // Try to find native docker builder, otherwise run emulated build
      const envAdd: any = {};
      if (
        ['amd64', 'i386', 'i386-nlp'].includes(arch) &&
        dockerHostAmd64 !== ''
      ) {
        if (DEBUG)
          console.log(
            `[open-balena-builder] Using native amd64 builder to build ${arch} image`
          );
        envAdd.DOCKER_HOST = dockerHostAmd64;
      } else if (
        ['aarch64', 'armv7hf', 'rpi'].includes(arch) &&
        dockerHostArm64 !== ''
      ) {
        if (DEBUG)
          console.log(
            `[open-balena-builder] Using native arm64 builder to build ${arch} image`
          );
        envAdd.DOCKER_HOST = dockerHostArm64;
      } else {
        emulated = 'true';
        if (dockerHostAmd64 !== '') {
          if (DEBUG)
            console.log(
              `[open-balena-builder] No native builder avialable to build ${arch} image; running emulated build on amd64 builder`
            );
          envAdd.DOCKER_HOST = dockerHostAmd64;
        } else {
          if (DEBUG)
            console.log(
              `[open-balena-builder] No native builder avialable for ${arch}; running emulated build on arm64 builder`
            );
          envAdd.DOCKER_HOST = dockerHostArm64;
        }
      }

      // Build image and return stream
      const { spawnStream } = await exec(
        [
          '/usr/local/bin/balena',
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
      if (headless === 'false') {
        // Detect abort by client (response closure) and kill build if received
        let finished = false;
        spawnStream.on('close', () => {
          finished = true;
        });
        res.on('close', () => {
          if (!finished) {
            if (DEBUG)
              console.log(
                '[open-balena-builder] Build request aborted by client'
              );
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

        // Wait for build to finish
        await once(spawnStream, 'close');

        // Get prior release images
        // Generate deltas to prior release images
        // Delete images or tag images and keep?
      }
    } catch (err) {
      res.status(400).send(err.message);
    }

    // Delete build directory and all contents
    if (workdir && fs.existsSync(workdir))
      fs.rmSync(workdir, { recursive: true });
  });

  app.listen(listenPort, () => {
    console.log(`[open-balena-builder] Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
