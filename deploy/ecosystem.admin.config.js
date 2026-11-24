// pm2 settings for the admin panel. Copy to /home/ubuntu on the server, then:
//   pm2 start ~/ecosystem.admin.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'buraco-admin',
      cwd: '/home/ubuntu/buraco-admin',
      script: 'node_modules/next/dist/bin/next',
      // Local only: the public address goes through Caddy (HTTPS).
      args: 'start -p 3100 -H 127.0.0.1',
      env: { NODE_ENV: 'production' },
      // The server is small: restart the panel if it ever grows past this, instead of letting
      // it squeeze the game server.
      max_memory_restart: '300M',
    },
  ],
};
