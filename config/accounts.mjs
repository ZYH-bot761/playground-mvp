/**
 * 演示账号（服务端校验用，不会被前端打包）。
 * 本地 dev 的 /api/room 与 Netlify Functions 都读取这一份。
 */
export default {
  accounts: [
    { user: 'player1', pass: 'play1234', name: '小星', color: '#ffb26b' },
    { user: 'player2', pass: 'play1234', name: '小月', color: '#6bc6ff' },
  ],
};