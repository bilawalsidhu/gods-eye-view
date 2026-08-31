module.exports = {
  run: [
    {
      method: 'shell.run',
      params: {
        path: '..',
        message: 'node scripts/pinokio-reset.mjs',
      },
    },
  ],
};
