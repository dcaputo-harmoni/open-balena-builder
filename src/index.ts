import * as express from 'express';
import * as fs from 'fs';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import { once } from 'events';

const PORT = 80;
const DEBUG = true;

const exec = (cmd: string) => {
  if (DEBUG) console.log(`[open-balena-builder] EXECUTING COMMAND: ${cmd}`);
  const result = execSync(cmd);
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
          `[open-balena-builder] REQUEST: ${JSON.stringify({
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

      // Pull environment variables
      const registry = process.env.REGISTRY_HOST;
      const user = process.env.BALENAOS_USERNAME;
      const pass = process.env.BALENAOS_APIKEY;

      // Generate image tag and set up workdir
      const imgname = crypto.randomUUID().replace(/[^0-9a-f]/gi, '');
      const imgpath = `${registry}/v2/${imgname}`;
      workdir = `/tmp/${imgname}`;
      fs.mkdirSync(workdir);

      // Save tar file to workdir
      const filestream = fs.createWriteStream(`${workdir}/build.tar`);
      req.pipe(filestream);
      await once(filestream, 'complete');

      // TODO: use balena-cli?

      // Authenticate with registry and create auth.json
      exec(
        `buildah login --authfile ${workdir}/auth.json -u ${user} -p ${pass} ${registry}`
      );

      // Setup buildah build params
      const auth = `--authfile ${workdir}/auth.json`;
      const stor = `--storage-driver vfs`;
      const quiet = DEBUG ? '' : '--quiet';

      // Build image
      exec(
        `buildah bud ${auth} ${stor} ${quiet} -f ${workdir}/${dockerfilePath} -t ${imgpath} ${workdir}`
      );

      // Push image
      exec(`buildah push ${auth} ${stor} ${imgpath}`);

      // Create release in api

      // Generate delta images

      // Delete image
      exec(`buildah rmi --storage-driver vfs ${imgpath}`);

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

  app.listen(listenPort, () => {
    console.log(`[open-balena-builder] Listening on port: ${listenPort}`);
  });
}

createHttpServer(PORT);
