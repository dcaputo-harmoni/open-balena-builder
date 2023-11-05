import * as express from 'express';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';

const PORT = 80;
const DEBUG = true;

// Pull environment variables
const registry = process.env.REGISTRY_HOST;
const builderToken = process.env.TOKEN_AUTH_BUILDER_TOKEN;

const exec = (cmd: string, cwd: string) => {
  if (DEBUG) console.log(`[open-balena-builder] EXECUTING COMMAND: ${cmd}`);
  const env = {
    BALENARC_BALENA_URL: registry?.substring(0, registry.indexOf('.')),
    BALENARC_DATA_DIRECTORY: cwd,
    REGISTRY_AUTH_FILE: `${cwd}/auth.json`,
  };
  const result = execSync(cmd, { cwd, env });
  if (DEBUG) console.log(`[open-balena-builder] COMMAND RESULT: ${result}`);
  return result;
};

async function createHttpServer(listenPort: number) {
  const app = express();

  app.post('/v3/build', async (req, res) => {
    let resp = '';

    // Set up build environment
    let workdir;

    try {
      const { slug, dockerfilePath, emulated, nocache, headless, isdraft } =
        req.query;
      if (DEBUG)
        console.log(
          `[open-balena-builder] BUILD REQUEST: ${JSON.stringify({
            slug,
            dockerfilePath,
            emulated,
            nocache,
            headless,
            isdraft,
          })}`
        );
      const jwt = req.headers.authorization?.split(' ')?.[1];
      if (!slug) throw new Error('app slug must be specified');
      if (!jwt) throw new Error('authorization header must be provided');

      // Set up workdir
      const uuid = crypto.randomUUID();
      workdir = `/tmp/${uuid}`;
      fs.mkdirSync(workdir);

      // Save tar file to workdir
      const filestream = fs.createWriteStream(`${workdir}/build.tar`);
      req.pipe(filestream);
      await once(filestream, 'complete');

      // Extract tar archive
      exec(`tar xf ${workdir}/build.tar`, workdir);

      // Authenticate with registry and create auth.json
      exec(`balena login -t ${builderToken}`, workdir);

      // Build image
      exec(`balena deploy ${slug} --build`, workdir);

      // Generate delta images

      // Delete images or tag images and keep

      resp = JSON.stringify({ success: true });
    } catch (err) {
      resp = JSON.stringify({ success: false, message: err.message });
    }

    // Delete build directory and all contents
    if (workdir && fs.existsSync(workdir))
      fs.rmSync(workdir, { recursive: true });

    // Respond with result
    if (DEBUG) console.log(`[open-balena-builder] RESPONSE: ${resp}`);
    res.set('Content-Type', 'text/html');
    res.send(resp);
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
          `[open-balena-builder] DELTA REQUEST: ${JSON.stringify({
            src,
            dest,
          })}`
        );

      const jwt = req.headers.authorization?.split(' ')?.[1];
      if (!src || !dest)
        throw new Error('src and dest url params must be provided');
      if (!jwt) throw new Error('authorization header must be provided');

      // Determine delta image tag
      const srcId = /^(.*)?\/v[0-9]+\/([0-9a-f]+)$/.exec(src as string)?.[2];
      const destId = /^(.*)?\/v[0-9]+\/([0-9a-f]+)$/.exec(dest as string)?.[2];
      const deltatag = `delta-${srcId?.substring(0, 16)}`;
      const deltaimg = `${dest}:${deltatag}`;
      const deltaimgId = `${destId}:${deltatag}`;

      // Determine folders to work in
      const uuid = crypto.randomUUID();
      const tmpWorkdir = `/tmp/${uuid}`;
      const buildWorkdir = `/tmp/${deltaimgId}`;

      // set tmpWorkdir as active workdir and create it
      workdir = tmpWorkdir;
      fs.mkdirSync(tmpWorkdir);

      // Authenticate with registry and create auth.json
      exec(`docker login -u builder -p ${builderToken} ${registry}`, workdir);

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
      let exists = true;
      try {
        exec(`docker manifest inspect ${deltaimg}`, workdir);
      } catch (err) {
        exists = false;
      }

      // Build delta image only if it doesn't already exist in the registry
      if (!exists) {
        // Move temp to build directory and populate with deltaimage binary
        fs.mkdirSync(buildWorkdir);
        fs.copyFileSync(`${tmpWorkdir}/auth.json`, `${buildWorkdir}/auth.json`);
        fs.rmSync(tmpWorkdir, { recursive: true });
        workdir = buildWorkdir;
        fs.copyFileSync(`/opt/deltaimage`, `${buildWorkdir}/deltaimage`);

        // Setup build params
        const quiet = DEBUG ? '' : '--quiet';

        // Generate diff image
        fs.writeFileSync(
          `${buildWorkdir}/Dockerfie.diff`,
          exec(`/opt/deltaimage docker-file diff ${src} ${dest}`, workdir)
            .toString()
            .replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.')
        );

        // Build diff dockerfile (--no-cache)
        exec(
          `docker build ${quiet} -f ${buildWorkdir}/Dockerfie.diff -t ${uuid} ${buildWorkdir}`,
          workdir
        );

        // Generate delta dockerfile
        fs.writeFileSync(
          `${buildWorkdir}/Dockerfie.delta`,
          exec(`/opt/deltaimage docker-file apply ${uuid}`, workdir)
            .toString()
            .replace(/--from=deltaimage\/deltaimage:0.1.0 \/opt/g, '.')
        );

        // Build delta image
        exec(
          `docker build ${quiet} -f ${buildWorkdir}/Dockerfie.delta -t ${deltaimg} ${buildWorkdir}`,
          workdir
        );

        // Push delta image
        exec(`docker push ${dest}:${deltatag}`, workdir);

        // Delete diff and delta images (not needed locally)
        exec(`docker rmi ${uuid} ${dest}:${deltatag}`, workdir);
      }

      resp = JSON.stringify({ success: true, name: `${deltaimg}` });
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
