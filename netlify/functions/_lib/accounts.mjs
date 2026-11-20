/**
 * 演示账号（服务端校验用，不会被前端打包）。
 * 放在 Netlify Functions 目录内，保证函数打包自包含；本地 /api/room 也读取这一份。
 */
export default {
  accounts: [
    { user: 'player1', pass: 'play1234', name: '小星', color: '#ffb26b' },
    { user: 'player2', pass: 'play1234', name: '小月', color: '#6bc6ff' },
  ],
};