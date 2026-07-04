module.exports = {
  apps: [
    {
      name: "tastytrade-golden-lion",
      cwd: __dirname,
      script: "./build/index.js",
      interpreter: "node",
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