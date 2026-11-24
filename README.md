# 棱镜突破 · Prism Breach

浏览器多人 3D 机甲竞技游戏。React 与 Three.js 渲染客户端，Node 与 TypeScript 运行账号、大厅和权威对局，PostgreSQL 保存档案和战绩，Redis 管理队列、在线状态和租约。玩家可以在突击与采矿机甲之间切换，争夺矿脉和团队经济。

- 快速匹配：支持单人或最多三名好友组队，六名真人各自确认后开始 3v3。同组玩家始终在同队；两张地图轮换，公开局结算成长和战绩。
- 邀请码房：支持分享链接、选队、准备和 3 秒开局倒计时。可选团队对抗、核心争夺或个人混战，机器人可补齐席位，自定义局不发放成长奖励。
- 邮箱账号：注册、验邮、密码找回和跨设备档案。好友码可用于添加好友，也可直接邀请好友入房或组队。
- 对局中掉线 60 秒内可续局。文字聊天限同房，支持屏蔽和举报；团队模式按住 **G** 选择战术标记。

## 本机开发

先依照 [闭测运行手册](ops/README.md) 创建 .env 并为 PostgreSQL、Redis 配置连接。运行：

    npm ci
    npm run dev

打开 http://localhost:3000，用测试访问码注册。生产构建由 npm run build 生成，使用 npm start 在同一地址提供页面和 WebSocket。

    npm run lint
    npm test
    npm run test:integration
    npm run test:browser

集成与浏览器测试需接入专用 PostgreSQL、Redis，不能指向生产。浏览器测试需要先运行 npx playwright install chromium firefox。自动构建、同源代理、Prometheus、在线上限 100 → 300 → 1,000、停新局及 PostgreSQL 备份/独立恢复见 [运行手册](ops/README.md)，实际通过的检查和未完成项见 [验收记录](ops/acceptance.md)，进程结构与协议见 [开发说明](ops/architecture.md)。客户端使用仓库原有的 RoboMaster S1/EP URDF 模型及其 DAE 网格和贴图，通过原有加载流程显示；正式公开发布前仍需核验这些资源的授权和品牌使用。中国大陆公开入口默认关闭；正式 1,000 在线容量、官方实名与大陆三网验收尚未完成。
