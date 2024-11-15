module.exports = {
  apps: [{
    name: 'repo-scanner',
    script: 'index.js',
    // Specify node args if needed
    node_args: '--max-old-space-size=1024',
    // Environment variables
    env: {
      NODE_ENV: 'production',
    },
    // Restart application if it exceeds memory limit
    max_memory_restart: '200M',
    // Error log file path
    error_file: 'logs/error.log',
    // Out log file path
    out_file: 'logs/out.log',
    // Time between automatic restarts
    min_uptime: '60s',
    max_restarts: 10,
    // Restart app if it crashes
    autorestart: true,
    // Watch for file changes (disable in production)
    watch: false,
    // Ignore files/folders to watch
    ignore_watch: ['node_modules', 'logs'],
    // Merge logs
    merge_logs: true,
    // Delay between restart attempts
    restart_delay: 4000
  }]
}