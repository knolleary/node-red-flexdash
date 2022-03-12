// FlexDash Development Server
// Copyright (c) 2022 by Thorsten von Eicken, see LICENSE

const fs = require('fs')
const http = require('http')
const path = require('path')
const cp = require('child_process')
const glob = require('glob')
const tar = require('tar')
const { createProxyMiddleware } = require('http-proxy-middleware');
const util = require('util')
const exec = util.promisify(require('child_process').exec)
const JS = JSON.stringify

// ViteDevServer is a singleton class that manages an Vite development server process. The reason to
// a singleton is that the proxy modifies files on disk, which becomes a mess if multiple proxies are
// active. Also the websock proxy is effectively mounted at the root and so multiple ones are
// difficult to multiplex.
class ViteDevServer {

}

module.exports = function (RED) {

  // Development server based on vite to serve up a dev version of the FlexDash dashboard.
  // 'this' is the node being constructed and config are the values set in the flow editor.
  class flexdashDevServer {
    constructor(config) {
      try { // use try-catch to get stack backtrace of any error
        const fd = RED.nodes.getNode(config.fd) // get a handle onto FlexDash
        RED.nodes.createNode(this, config)
        //this.log(`flexdashDevServer for ${fd?.name}: ${JSON.stringify(config)}`)
        
        this.fd = fd
        this.enable = config.enable
        this.install = config.install
        this.name = fd?.name || "FlexDash"
        this.path = fd?.path == '/' ? "flexdash-src" : fd?.path + "-src"
        this.log("path       : " + this.path)

        //this.log(`cwd: ${process.cwd()}, data: ${RED.settings.userDir}`)
        // this.sourceDir = config.sourceDir
        // if (this.sourceDir.startsWith("~/")) this.sourceDir = this.sourceDir.replace("~", process.cwd())
        // if (this.sourceDir.startsWith("./")) this.sourceDir = this.sourceDir.replace(".", RED.settings.userDir)
        this.sourceDir = path.join(RED.settings.userDir, "flexdash-src")
        this.viteBin = path.join(this.sourceDir, "node_modules", "vite", "bin", "vite.js")
        this.log("source dir : " + this.sourceDir)

        this.vite = this.vitePort = this.viteReady = this.viteProxy = null

        if (this.enable) { // delay startVite a tad so the rest of the flow can finish init'ing in peace
          setTimeout(() => this.startVite().then(()=>{}), 500)
        } else {
          this.showStatus()
        }
      } catch (e) { console.error(e.stack); throw e }

      this.on("close", () => this.stopVite())

      // handle flow input messages, basically massage them a bit and update the FD widget
      this.on("input", msg => {
        console.log("on-input:", JSON.stringify(msg))
        switch(msg.payload) {
          case "stop": this.stopVite(); break
          case "restart": this.restart(); break
          case "start": this.startVite().then(()=>{}); break
          default: this.warn(`unknown command: ${msg.payload}, expected "start", "stop" or "restart"`)
        }
      })
    }

    // check that everything is set-up correctly for vite to run
    // returns "OK" or an error string suitable for node status if not
    checkSetup() {
      if (!fs.existsSync(this.sourceDir)) return `no ${this.sourceDir}`
      if (!fs.existsSync(this.viteBin)) return `no vite in ${this.sourceDir}`
      try { fs.accessSync(this.sourceDir, fs.constants.W_OK) }
      catch(e) { return `cannot write to ${this.sourceDir}` }
      if (!this.fd?.app) return "FlexDash config node not deployed"
      return "OK"
    }

    // show a node status dot and message, err is optional
    showStatus(err) {
      if (err && err != "OK") {
        this.status({fill:"red",shape:"dot",text:err})
      } else if (this.vite && this.viteReady) {
        this.status({fill:"green",shape:"dot",text:"running"})
      } else if (this.vite && !this.viteReady) {
        this.status({fill:"yellow",shape:"dot",text:"starting"});
      } else if (!err && (err=this.checkSetup()) != "OK") {
        this.status({fill:"red",shape:"dot",text:err})
      } else {
        this.status({fill:"grey",shape:"dot",text:"stopped"});
      }
    }

    async startVite() {
      try {
        if (this.install && !fs.existsSync(this.sourceDir)) {
          await this.installSrc()
        }

        const err = this.checkSetup()
        if (err != "OK") {
          this.warn("Cannot start dev server: " + err)
          this.showStatus(err)
          return
        }

        // const tempDir = await this.genTempDir()
        // this.log("temp dir   : " + tempDir)
        // gen vite config
        const viteConfigIn = path.join(this.sourceDir, "vite.config.js")
        const viteConfig = path.join(this.sourceDir, `.vite.config-${this.name}.js`)
        await this.genViteConfig(viteConfigIn, viteConfig, this.path, this.sourceDir)
        // gen index.html
        // const indexConfigIn = path.join(this.sourceDir, "index.html")
        // const indexConfig = path.join(this.sourceDir, `.index-${this.name}.html`)
        // await this.genIndexHtml(indexConfigIn, indexConfig)
        // symlink xtra directory to external widgets
        await this.symlinkXtra(path.join(this.sourceDir, "xtra"),
          [ process.cwd(), RED.settings.userDir ])

        // launch process and register handlers for stdout/stderr
        const env = { HOME: process.env.HOME, PATH: process.env.PATH, SHELL: process.env.SHELL}
        this.vite = cp.spawn(this.viteBin, ["-c", viteConfig, "--no-clearScreen"],
          { cwd: this.sourceDir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        this.showStatus("OK")

        // process std, primarily to find out which port vite is listening on
        this.vite.stdout.on('data', data => {
          data = data.toString()
          console.log(data.replace(/[^\n]*\n/gs, "FD dev: $&").trimEnd())
          let m
          if (m = data.match(/^\s+> Local: http:\/\/localhost:(\d+)\//m)) {
            this.vitePort = parseInt(m[1], 10)
            this.log(`vite started on port ${this.vitePort}`)
          }
          if (m = data.match(/^\s+ready in (\d+)ms/m)) {
            this.log(`vite ready in ${m[1]}ms`)
            this.startProxying()
            this.viteReady = true
            this.showStatus("OK")
          }
        })
        this.vite.stderr.on('data', data => {
          const l = data.toString().replace(/[^\n]*\n/gs, "FD dev ERR: $&").trimEnd()
          console.log(l)
        })
      } catch(e) {
        this.warn(`*** FlexDash Dev server did not start: ${e.stack}`)
        this.status({fill:"red",shape:"dot",text:"see node-RED log"})
      }
    }

    stopVite() {
      if (this.vite) {
        this.log("Stopping vite")
        this.vite.kill()
        console.log(Object.keys(this.viteProxy))
        if (this.viteProxy?.proxy) { console.log("*** CLOSING"); this.viteProxy.proxy.close() }
        this.vite = this.vitePort = this.viteReady = this.viteProxy = null
        this.showStatus("OK")
        if (this.viteProxy) this.stopProxying()
        //this.remTempDir().then(()=>{})
      }
    }

    restart() { this.stopVite(); this.startVite() }

    // ===== proxy to vite

    mungeResponse(url, resp, from, to) {
      let buff = []
      //console.log(`munge requesting ${url}`)
      const req = http.request(url, res => {
        delete res.headers['content-length']
        delete res.headers['connection']
        resp.writeHead(res.statusCode, res.statusMessage, res.headers)
        res.on('data', chunk => { buff.push(chunk) })
        res.on('end', () => {
          const data = buff.join("").replace(from, to)
          resp.end(data)
        })
      })
      req.on('error', e => {
        this.log(`Error proxying ${url}: ${e}`)
        resp.end(500)
      })
      req.end()
    }

    // proxy to vite
    startProxying() {
      const proxyUrl = `http://localhost:${this.vitePort}`
      this.viteProxy = createProxyMiddleware({ target: proxyUrl+'/', ws: false, autoRewrite: true })
      // express does not support unmounting of handlers, so we have to fake it by interposing a
      // middleware, not great, but at least it works
      let wsSubscribed = false
      this.fd.app.use(this.path, (req, res, next) => {
        //this.log(`PROXY ${req.url} (${req.originalUrl})`)
        if (!this.viteProxy) return next() // we're dead, wish we could unmount...

        // we can't ask http-proxy-middleware to deal with websockets because it has no way to remove
        // the subscription if we decide to stop & restart proxying. So we have to intercept http
        // upgrade requests ourselves and decide which proxy takes them. We can only register the
        // upgrade handler on the first request because we don't have access to the server object before.
        if (!wsSubscribed) {
          const server = (req.socket ?? req.connection)?.server // hack!
          server.on('upgrade', async (req, socket, head) => {
            let url = req.url || re.originalUrl
            if (url.endsWith("/")) url = url.slice(0, -1)
            if (this.viteProxy && url == this.path) this.viteProxy.upgrade(req, socket, head)
          })
          wsSubscribed = true
        }

        // proxy / to return munged index.html (insert socket.io url)
        if (req.url == '/') {
          if (!req.originalUrl.endsWith('/')) req.originalUrl += '/'
          const url = proxyUrl + req.originalUrl + 'index.html'
          this.mungeResponse(url, res, '{}',
              `{sio:window.location.origin+"${this.fd.ioPath}",title:"${this.fd.name}"}`)

        // proxy vite client source (/@vite.client) to munge vite's port
        } else if (req.url == '/@vite/client') {
          // extract port from host header of incoming request
          const url = proxyUrl + req.originalUrl
          const m = req.get('Host').match(/^[^:]+:(\d+)/)
          const port = m ? parseInt(m[1], 10) : (req.protocol == "https" ? 443 : 80)
          this.mungeResponse(url, res, "1880/flexdash-src/", `${port}/flexdash-src/`)
        } else {
          this.viteProxy(req, res, next)
        }
      })
      this.log(`proxying ${this.path} to vite on port ${this.vitePort}`)
    }

    // ===== directories and files

    // create a temporary directory to run vite and symlink to everything we need, the reason is that
    // we can't necessarily write to the flexdash source dir (e.g., got clone as some user, and node-red
    // running as another)
    // Note: will throw on error
    // async genTempDir() {
    //   const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'node-red-vite-'))
    //   // symlink to everything in flexdash source dir except vite config and index.html
    //   const files = await fs.promises.readdir(this.sourceDir, { withFileTypes: true });
    //   for (const file of files) {
    //     if (file.name === 'vite.config.js' || file.name === 'index.html') continue
    //     await fs.promises.symlink(
    //       path.join(this.sourceDir, file.name),
    //       path.join(tempDir, file.name),
    //       file.isDirectory() ? 'dir' : 'file'
    //     )
    //   }
    //   //this.log("Symlinked " + files.map(f=>f.name).join(", "))
    //   return tempDir
    // }

    // async remTempDir() {
    //   const tempDir = this.tempDir
    //   try {
    //     this.tempDir = null
    //     const files = await fs.promises.readdir(tempDir, { withFileTypes: true });
    //     for (const file of files) {
    //       await fs.promises.rm(path.join(tempDir, file.name))
    //     }
    //     await fs.promises.rmdir(tempDir)
    //   } catch(e) {
    //     this.warn(`Error removing vite temp dir ${tempDir}: ${e}`)
    //   }
    // }
    
    // generate vite config, we need to tweak paths and make sure it uses the correct port
    async genViteConfig(infile, outfile, path, sourceDir) {
      let config = await fs.promises.readFile(infile, "utf8")
      // prep what we want
      const opts = {
        //root: tempDir,
        base: path + '/', // URL path to get to dev dashboard...
        LogLevel: 'info',
        server: {
          hmr: { clientPort: 1880 }, // causes browser to be told to open ws to NR port
          fs: { allow: [ sourceDir, process.cwd(), RED.settings.userDir ] },
        }
      }
      // change base and add stuff in
      const optsJson = JSON.stringify(opts).slice(1, -1) + ','
      config = config.replace(/^\s*base: .*/m, optsJson)
      await fs.promises.writeFile(outfile, config)
    }

    // async genIndexHtml(infile, outfile) {
    //   let html = await fs.promises.readFile(infile, "utf8")
    //   html = html.replace('{}', `{sio:window.location.origin+"${this.fd.ioPath}",title:"${this.fd.name}"}`)
    //   await fs.promises.writeFile(outfile, html)
    // }

    async symlinkXtra(xtraDir, dirs) {
      // ensure the xtra dir exists
      try { await fs.promises.access(xtraDir, fs.constants.F_OK) }
      catch (e) { await fs.promises.mkdir(xtraDir) }
      // remove existing symlinks
      for (const f of await fs.promises.readdir(xtraDir)) {
        const link = path.join(xtraDir, f)
        this.log("Removing existing symlink " + link)
        await fs.promises.unlink(link)
      }
      // symlink to dirs that may have widgets
      const prom = new Promise((resolve, reject) => {
        let cnt = 0 // count of oustanding callbacks from glob
        let errs = []

        // given an array of paths, create a symlink to each one in the xtraDir
        const linkWidgetDir = (err, paths) => {
          //console.log(`LWD: ${err} ${paths}`)
          if (err) {
            errs.append(err)
          } else {
            for (const p of paths||[]) {
              // p is of the form /<dir1>/.../<dirN>/widgets, we want to link to dirN and use that as name
              const tgt = path.dirname(p)
              const name = path.basename(tgt)
              fs.symlink(tgt, path.join(xtraDir, name), 'dir', err => {
                if (err) errs.append(err)
                else this.log(`xtra: ${p}`)
              })
            }
          }
          // if we're done with all outstanding callbacks then resolve/reject the promise
          cnt--
          if (cnt == 0) {
            if (errs.length > 0) reject(errs)
            else resolve()
          }
        }

        // iterate through all dirs, find widget dirs, and symlink them
        for (let dir of dirs) {
          dir = this.resolvePath(dir)
          this.log("xtra: searching in " + dir)
          cnt += 2 // launching two globs
          glob(`${dir}/widgets`, linkWidgetDir)
          glob(`${dir}/node-red-fd-*/widgets`, linkWidgetDir)
          glob(`${dir}/node_modules/node-red-fd-*/widgets`, linkWidgetDir)
        }
      })
      await prom
    }

    resolvePath(path) {
      if (path.startsWith("~/")) path = path.replace("~", process.cwd())
      else if (path.startsWith("./")) path = path.replace(".", RED.settings.userDir)
      return path
    }

    async installSrc() {
      // // locate source tgz
      // const files = await fs.promises.readdir(__dirname)
      // files.sort()
      // files.reverse()
      // this.log(`files: ${files.join(' ')}`)
      // const tgz = files.find(f => f.match(/flexdash-([0-9.]+)-src.tgz/))
      // if (!tgz) throw new Error(`Could not find source tgz in ${__dirname}`)
      // extract to sourceDir
      this.log("Extracting and installing flexdash sources to " + this.sourceDir)
      if (!fs.existsSync(this.sourceDir)) await fs.promises.mkdir(this.sourceDir)
      const tgz = path.join(__dirname, 'flexdash-src.tgz')
      await tar.x({file:tgz, cwd:this.sourceDir})
      this.status({fill:"yellow", shape:"dot", text:"running npm install"})
      let { stdout, stderr } = await exec("npm install --no-audit --no-fund", { cwd: this.sourceDir })
      if (stderr) {
        stderr = stderr.replace(/npm WARN [^\n]*\n/gs, '')
        if (stderr) this.warn("FlexDash source npm install\n" + stderr)
      }
    }
    
  }

  RED.nodes.registerType("flexdash dev server", flexdashDevServer)

  // POST handler for button in flow editor, copied from inject node
  RED.httpAdmin.post("/fd-dev-server/:id/restart", RED.auth.needsPermission("inject.write"), function (req, res) {
    var node = RED.nodes.getNode(req.params.id)
    if (node != null) {
      try {
        node.receive({ payload: "restart" })
        // if (req.body && req.body.__user_fddev_props__) {
        //   node.receive(req.body)
        // } else {
        //   node.receive()
        // }
        res.sendStatus(200)
      } catch (err) {
        res.sendStatus(500)
        node.error("FlexDash dev server restart failed:" + err.toString())
      }
    } else {
      res.sendStatus(404)
    }
  })

}
