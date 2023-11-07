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
const registryHost = String(
  process.env.REGISTRY_HOST ?? `registry.${balenaTld}`
);
const builderToken = String(process.env.TOKEN_AUTH_BUILDER_TOKEN);
const dockerHost = String(process.env.DOCKER_HOST);
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
    DOCKER_HOST: dockerHost,
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

      // Set docker host for arm64 architecture, otherwise force emulated if arm64 host not available
      const envAdd: any = {};
      if (arch === 'aarch64') {
        if (dockerHostArm64 !== '') {
          if (DEBUG)
            console.log(
              '[open-balena-builder] Application has aarch64 and arm64 builder avialable; running build on native arm64 builder'
            );
          envAdd.DOCKER_HOST = dockerHostArm64;
        } else {
          if (DEBUG)
            console.log(
              '[open-balena-builder] Application has aarch64 and no arm64 builder avialable; running emulated build'
            );
          emulated = 'true';
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
        const outTransform = new stream.Transform();
        outTransform._transform = function (
          chunk: Buffer,
          _encoding,
          callback
        ) {
          this.push(
            JSON.stringify({
              message: { message: chunk.toString(), isError: false },
            })
          );
          callback();
        };
        const errTransform = new stream.Transform();
        errTransform._transform = function (
          chunk: Buffer,
          _encoding,
          callback
        ) {
          this.push(
            JSON.stringify({
              message: { message: chunk.toString(), isError: true },
            })
          );
          callback();
        };

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

  app.get('/api/v3/delta', async (req, res) => {
    let resp = '';

    // Set up build environment
    let workdir;

    try {
      // src = old image which we are transitioning from
      // dest = new image which we are transitioning to
      const { src, dest } = req.query;
      if (DEBUG)
        console.log(
          `[open-balena-builder] Delta request received: ${JSON.stringify({
            src,
            dest,
          })}`
        );
      // Parse input params
      const jwt = req.headers.authorization?.split(' ')?.[1];
      const srcMatch = /^.*?\/v([0-9]+)\/([0-9a-f]+)$/.exec(String(src));
      const destMatch = /^.*?\/v([0-9]+)\/([0-9a-f]+)$/.exec(String(dest));

      // Validate input params
      if (!srcMatch || !destMatch)
        throw new Error('src and dest url params must be provided');
      if (!jwt) throw new Error('authorization header must be provided');
      const [, srcImgVer, srcImgBase] = srcMatch;
      const [, destImgVer, destImgBase] = destMatch;
      if (srcImgVer !== destImgVer) {
        throw new Error('src and dest image versions must match');
      }

      // Generate delta image name and path
      const deltaTag = `delta-${String(srcImgBase).substring(0, 16)}`;
      const deltaImgBase = `${destImgBase}:${deltaTag}`;
      const deltaImgFull = `v${destImgVer}/${deltaImgBase}`;
      const deltaImgPath = `${registryHost}/${deltaImgFull}`;

      // Determine folders to work in and diff image name
      const uuid = crypto.randomUUID();
      const diffImgFull = `local/${uuid}`;
      const tmpWorkdir = `/tmp/${uuid}`;
      const buildWorkdir = `/tmp/${deltaImgBase}`;

      // set tmpWorkdir as active workdir and create it
      workdir = tmpWorkdir;
      fs.mkdirSync(tmpWorkdir);

      // TO DO: Only do if arm64 architecture verified and dockerHostArm64 is set
      const envAdd = dockerHostArm64 ? { DOCKER_HOST: dockerHostArm64 } : {};

      // Authenticate with registry
      await exec(
        ['docker', 'login', '-u', 'builder', '-p', builderToken, registryHost],
        workdir,
        envAdd
      );

      // Check if we are currently building delta image in a parallel process, if so, wait until complete
      if (fs.existsSync(buildWorkdir)) {
        let elapsedSecs = 0;
        const sec = () => new Promise((resolve) => setTimeout(resolve, 1000));
        do {
          await sec();
          elapsedSecs++;
        } while (fs.existsSync(buildWorkdir) && elapsedSecs < 60 * 20); // 20 min timeout
      }

      // Determine if delta image already exists in registry
      const exists =
        (
          await exec(
            ['docker', 'manifest', 'inspect', deltaImgPath],
            workdir,
            envAdd
          )
        ).code === 0;

      // Build delta image only if it doesn't already exist in the registry
      if (!exists) {
        // Move temp to build directory and populate with deltaimage binary
        fs.mkdirSync(buildWorkdir);
        fs.cpSync(`${tmpWorkdir}/.docker`, `${buildWorkdir}/.docker`, {
          recursive: true,
        });
        fs.cpSync(`/opt/deltaimage`, `${buildWorkdir}/deltaimage`);
        fs.rmSync(tmpWorkdir, { recursive: true });
        workdir = buildWorkdir;

        // Setup build params
        const quiet = DEBUG ? '' : '--quiet';

        // Generate diff dockerfile
        fs.writeFileSync(
          `${buildWorkdir}/Dockerfie.diff`,
          (
            await exec(
              [
                '/opt/deltaimage',
                'docker-file',
                'diff',
                String(src),
                String(dest),
              ],
              workdir
            )
          ).stdout
            .toString()
            .replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.')
        );

        // Build diff image (--no-cache)
        await exec(
          [
            'docker',
            'build',
            quiet,
            '-fDockerfie.diff',
            `-t${diffImgFull}`,
            '.',
          ],
          workdir,
          envAdd
        );

        // Generate delta dockerfile
        fs.writeFileSync(
          `${buildWorkdir}/Dockerfie.delta`,
          (
            await exec(
              ['/opt/deltaimage', 'docker-file', 'apply', diffImgFull],
              workdir
            )
          ).stdout
            .toString()
            .replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.')
        );

        // Build delta image (--no-cache)
        await exec(
          [
            'docker',
            'build',
            quiet,
            '-fDockerfie.delta',
            `-t${deltaImgPath}`,
            '.',
          ],
          workdir,
          envAdd
        );

        // Push delta image
        await exec(['docker', 'push', deltaImgPath], workdir, envAdd);

        // Delete diff and delta images (not needed locally)
        await exec(
          ['docker', 'rmi', diffImgFull, deltaImgPath],
          workdir,
          envAdd
        );
      }

      resp = JSON.stringify({ success: true, name: deltaImgPath });
    } catch (err) {
      resp = JSON.stringify({ success: false, message: err.message });
    }

    // Delete temp or build directory and all contents
    if (workdir && fs.existsSync(workdir))
      fs.rmSync(workdir, { recursive: true });

    // Respond with result
    if (DEBUG) console.log(`[open-balena-builder] RESPONSE: ${resp}`);
    res.set('Content-Type', 'text/html');
    res.send(resp);
  });

  app.listen(listenPort, () => {
    console.log(`[open-balena-builder] Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
