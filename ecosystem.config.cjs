module.exports = {
  apps: [
    {
      name: "silver-lynx-tastytrade",
      cwd: __dirname,
      script: "./build/index.js",
      // Pin to the Node that evaluates this config (the pm2 CLI's own runtime,
      // e.g. nvm's v24 when starting from a login shell). A bare "node" resolves
      // against the pm2 daemon's PATH, which under the systemd boot hook can be
      // an old system Node without the global WebSocket the quote streamer needs.
      interpreter: process.execPath,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      // Floor between crash restarts. The app also backs off in-process before
      // exiting on dxLink session-limit errors (quote-streamer-recovery.ts);
      // this is the safety net for every other crash path.
      restart_delay: 5000,
      watch: false,
      time: true,
      env: {
        NODE_ENV: "production",
        BOT_RUN_ON_SCHEDULE: "true",
      },
    },
  ],
};