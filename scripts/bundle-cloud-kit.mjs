// Prepare the Linux server and installation recipe for SSH deployment.
// An explicitly selected offline kit can also be supplied for private builds.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const target = path.resolve(process.argv[2], "cloud-linux-amd64.tar");
const digest = async file => {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
const offline = process.env.CAGE_CLOUD_KIT;
if (offline) {
  if (await digest(offline) !== fs.readFileSync(offline + ".sha256", "utf8").trim())
    throw Error("Cloud deployment kit checksum mismatch");
  fs.copyFileSync(offline, target);
} else {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "cage-bootstrap-"));
  try {
    const version = fs.readFileSync("VERSION", "utf8").trim();
    const binary = path.join(stage, "cage");
    for (const arch of ["amd64", "arm64"]) {
      if (!fs.existsSync(path.resolve("internal/tailnetassets/assets/cage-tailnet-linux-" + arch + ".gz"))) throw Error("Build Tailscale guest assets before packaging the cloud kit");
    }
    execFileSync("go", ["build", "-trimpath", "-ldflags", "-s -w -X github.com/sylvinus/agent-vm/internal/version.Version=" + version, "-o", binary, "./cmd/cage"], {
      env: {...process.env, CGO_ENABLED:"0", GOOS:"linux", GOARCH:"amd64"}, stdio:"inherit"
    });
    await pipeline(fs.createReadStream(binary), createGzip(), fs.createWriteStream(binary + ".gz"));
    fs.unlinkSync(binary);
    const {mihomo} = JSON.parse(fs.readFileSync("packaging/linux/dependencies.json"));
    const cache = path.resolve("_output/linux-deps", mihomo.file);
    const core = path.join(stage, "mihomo.gz");
    if (!fs.existsSync(cache)) {
      fs.mkdirSync(path.dirname(cache), {recursive:true});
      const download = fs.mkdtempSync(path.join(path.dirname(cache), "cloud-core-"));
      const partial = path.join(download, "partial");
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            execFileSync("curl", ["--fail", "--location", "--connect-timeout", "30",
              "--speed-limit", "1", "--speed-time", "120", "--continue-at", "-",
              "--output", partial, mihomo.url], {stdio:"inherit"});
            break;
          } catch (error) {
            if (attempt >= 3) throw error;
            // A server that refuses ranges must receive a fresh full request.
            if (error.status === 33) fs.rmSync(partial, {force:true});
          }
        }
        if (await digest(partial) !== mihomo.sha256) throw Error("Linux Mihomo checksum mismatch");
        fs.renameSync(partial, cache);
      } finally { fs.rmSync(download, {recursive:true, force:true}); }
    }
    fs.copyFileSync(cache, core);
    if (await digest(core) !== mihomo.sha256) throw Error("Linux Mihomo checksum mismatch");
    const recipe = path.join(stage, "deploy/cloud");
    fs.mkdirSync(recipe, {recursive:true});
    for (const name of ["Dockerfile.guest","restore-apt-sources.sh","build-guest.sh"])
      fs.copyFileSync(path.join("deploy/cloud",name),path.join(recipe,name));
    fs.mkdirSync(path.join(stage,"internal/cage"),{recursive:true});
    fs.copyFileSync("internal/cage/apt-bootstrap.sh",path.join(stage,"internal/cage/apt-bootstrap.sh"));
    for (const name of ["cage-server.service","cage-container-engine.service"])
      fs.copyFileSync(path.join("deploy/cloud",name),path.join(stage,name));
    const runtime = JSON.parse(fs.readFileSync("deploy/cloud/runtime-artifacts.json"));
    fs.writeFileSync(path.join(stage,"engine-downloads"),runtime.artifacts.map(a=>[a.sha256,a.file,a.url].join(" ")).join("\n")+"\n");
    execFileSync("tar", ["-cf",target,"-C",stage,"."],{env:{...process.env,COPYFILE_DISABLE:"1"},stdio:"inherit"});
  } finally { fs.rmSync(stage,{recursive:true,force:true}); }
}
fs.writeFileSync(target+".sha256",await digest(target)+"\n");
