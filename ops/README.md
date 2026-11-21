# 棱镜突破闭测运行手册

## 本机启动

需要 Node 24、PostgreSQL 和 Redis。使用隔离的测试库和 Redis 命名空间；仓库中的旧演示数据不会导入。

    cp .env.example .env
    docker compose up --build -d

Compose 默认只发布 127.0.0.1:3000。把 .env 中的测试码改成随机值，用浏览器打开 http://localhost:3000 后注册。测试邮箱不会发送外部邮件，以测试码读取待发送链接：

    curl -H 'x-playtest-key: YOUR_TEST_KEY' 'http://localhost:3000/api/test/mail?kind=verify&email=test%40example.com'

浏览器打开同源的 /?verify=TOKEN 后登录。找回密码查询 kind=reset，链接为 /?reset=TOKEN。

本地单人试玩可设置 ALLOW_SOLO_PLAYTEST=1 并重启服务：一个账号即可创建邀请码房、选择地图和模式后开局；勾选机器人补满六席可测试战斗，不勾选则可单独探索地图。此开关仅在 PUBLIC_ACCESS 不为 1 的私有环境生效，默认关闭；公开快速匹配仍需六名真人。

正式闭测配置 SMTP_FROM、SMTP_URL、真实 HTTPS ORIGIN 和 TEST_MAILBOX=0；保持 PUBLIC_ACCESS=0。根据 ops/Caddyfile 配置同源 HTTPS/WSS，设置 PRISM_HOST 并绑定证书。SMTP 登录凭证、测试码和数据库密码保存在部署环境中。

TRUST_PROXY 必须匹配实际代理拓扑。直接运行 Node 并由本机 Caddy 代理时使用 TRUST_PROXY=loopback；Compose 将应用端口限制在本机并设置 TRUST_PROXY=1，信任到应用的一个代理跳点。增加代理或负载均衡器时，重新配置可信地址或跳数并验证客户端 IP；应用端口不得绕过代理公开。错误的信任配置会影响注册、登录及找回密码的 IP 限流。

## 构建、监控与在线上限

GitHub Actions 配置位于 .github/workflows/validate.yml，执行类型检查、单元测试、生产构建、真实数据库/Redis 集成测试、Chromium/Firefox 浏览器流程及 Docker 镜像构建。本地验收结果及边界见 [验收记录](acceptance.md)。

启用可选监控组件：

    docker compose --profile monitoring up --build -d

Prometheus 只发布 127.0.0.1:9090，每 15 秒抓取应用 /metrics；ops/Caddyfile 阻止从公开域名访问 /metrics。ops/alerts.yaml 包含网关或依赖不可用、游戏进程退出、帧耗时 P99 超过 45 ms、结算失败规则。当前未配置 Alertmanager 或值班通知目的地，部署方需接入通知并演练送达；仓库中的规则不代表已完成通知验收。GET /api/health 同时报告在线上限、各进程状态与帧耗时。

ONLINE_LIMIT 控制已认证的操控连接上限。示例 .env 的 1000 用于私有容量测试；未显式配置时，PUBLIC_ACCESS=1 默认 100，私有环境默认 1000。获准开放后显式依次设置 ONLINE_LIMIT=100、300、1000 并重启部署，每档观察帧耗时、输入确认、重连、结算与错误率后再增加。改变配置或版本前先停新局并等待健康房间结束。公开资格和网络验收完成前，保持 PUBLIC_ACCESS=0。

## 运维与回滚

- 在一个 Redis 命名空间运行一个大厅网关。GAME_WORKERS 调整独立游戏进程数；每场在单个进程运行，进程退出只取消该进程上未提交的局。默认由机器 CPU 数决定，上限为四个，可显式覆盖。网关进程重启后，未提交的局不能续回。
- 探测 GET /api/health，监控 HTTP/WSS 可用率、在线数、各游戏进程的房间数和最近 1,200 个活动帧的 P99。告警条件至少包含持续 5xx、子进程不就绪、P99 逼近 50 ms、数据库或 Redis 不可用。通过容量脚本记录输入确认、续局、带宽和错误。生产容量应验证 1,000 在线、600 对局、持续 60 分钟以及真实 60 ms 往返延迟；本机短测不能替代这些验收。
- 停新局：在 Redis 执行 SET prism:drain 1（prism 是 REDIS_NAMESPACE 的默认值）。健康房间继续运行；清除该键恢复。DRAIN_MATCHES=1 可在启动时强制停新局。
- 回滚：停新局并等待健康房间结束，回滚到保留的上一版镜像和部署配置；在预发布验证账号、WebSocket、战绩后恢复接局。数据库模式变更保持兼容，必要时先备份及演练恢复。
- 管理员在 MODERATOR_EMAILS 配置后以已验邮的账号登录。按消息 ID 审阅、驳回、禁言或封禁；通过 CHAT_FILTER_TERMS 为运营补充过滤词并安排值守。

## 协议容量测试

先启动专用私有实例，初始化其数据库，并配置 ONLINE_LIMIT=1000、GAME_WORKERS=4。在加载器机器上设置 LOAD_ORIGIN 为该实例的同源地址、LOAD_DATABASE_URL 为专用测试库，LOAD_COOKIE_FILE 指向仓库外的新文件。以下操作直接创建已验邮测试账号及六小时会话，仅适用于隔离容量环境；不要使用生产库或生产会话。

    LOAD_ISOLATED=1 LOAD_USERS=1000 npm run load:provision

会话文件权限为 0600，不进入 Git 或报告。加载器会组成公开与自定义满员房，自动确认、移动、执行战斗动作、周期重连，并在结算后继续开局。为避免单个 Node 加载器成为瓶颈，可并行运行五个独立进程，每个使用 200 个不同账号、120 个对局玩家：

    for shard in 0 1 2 3 4; do
      LOAD_ISOLATED=1 LOAD_USERS=200 LOAD_ACTIVE=120 \
        LOAD_COOKIE_OFFSET=$((shard * 200)) LOAD_SHARD=$shard \
        LOAD_SECONDS=3600 LOAD_DELAY_MS=60 \
        npm run load:test > "/secure/load-shard-$shard.jsonl" &
    done
    wait
    node ops/aggregate-capacity.ts /secure/load-shard-{0,1,2,3,4}.jsonl

偏移值必须覆盖互不重叠的账号区间。多台加载器时同样分配不同偏移，并收集各日志；聚合脚本合并延迟直方图后计算总体 P95，拒绝重复分片或重叠账号。检查实际 inputHzPerActive 是否接近 20、1000 连接和 600 活跃是否维持、错误类型、各游戏进程帧 P99、带宽及重连样本数。输入确认按服务器累计已处理序号计算，跨局与重连期间的空档会降低总平均输入频率。

LOAD_DELAY_MS 在客户端收发两侧各增加半程应用计时器延迟，不能视为真实网络 RTT。正式验收在接近生产的分离加载器与服务器环境进行，使用真实网络或网络层延迟注入，并记录 CPU、内存、实例规格、网络吞吐和错误；避免与上述计时器重复注入。本次本机短测及其局限见 [验收记录](acceptance.md)。

## PostgreSQL 备份与独立恢复

运维机需要 Node 24、已安装项目依赖的仓库，以及与服务端兼容的 pg_dump/pg_restore；建议使用相同 PostgreSQL 主版本。命令从 PATH 查找客户端，也可设置 PG_BIN_DIR 指向客户端目录。应用运行镜像不包含这些运维工具，以下命令在有数据库网络访问的运维机执行。DATABASE_URL 和 RESTORE_ADMIN_URL 通过部署的密钥环境提供，避免写入命令历史；子进程通过独立的 libpq 环境连接，不在参数或日志打印连接字符串。

在仓库外创建仅运维账号可访问的目录，并选择一个从未使用过的文件名：

    mkdir -m 700 /secure/backups/prism
    npm run db:backup -- --out /secure/backups/prism/prism-20261121.dump

脚本使用 DATABASE_URL，从同一只读事务导出 PostgreSQL 一致性快照；pg_dump 和账号、已提交战绩、总 XP 统计都使用该快照。输出 custom 格式归档及相邻 .json 清单，包含 SHA256、长度、工具版本、数据库名称和验证数量，文件权限为 0600。已有归档或清单不会被覆盖。每天安排备份并保留已验证的历史版本；敏感备份包含邮箱、密码哈希、档案及聊天数据，目录权限不等于加密，需要另外加密异地副本并管理密钥及保留期限。

恢复时由 RESTORE_ADMIN_URL 指定有 CREATE DATABASE 权限的维护连接，目标必须是新的 prism_restore_ 开头数据库：

    npm run db:restore -- --from /secure/backups/prism/prism-20261121.dump \
      --database prism_restore_20261121_check

恢复前校验归档 SHA256 与长度，拒绝源数据库名及任何已存在的目标库。脚本只创建新库，不删除或覆盖数据库；失败的新库保留供检查。恢复在目标库清除会话和一次性令牌、过期游戏进程租约，并将未结束对局标记为取消，再核对账号数、已验邮账号、已提交对局、玩家结算及总 XP。运行后保留输出作为演练证据。

2026-11-21 已实际完成一次本地独立恢复：1,131 个账号、47 场已提交对局、178 条玩家结算、14,093 XP 全部与备份清单一致。恢复库使用新 Redis 命名空间实际登录成功，完整档案与备份数据一致，退出后旧会话失效。重复输出、已有目标库、源库名与损坏归档均被拒绝；详情见 [验收记录](acceptance.md)。

需要进行应用级恢复验证时，另起私有实例，将 DATABASE_URL 指向恢复库，使用全新 REDIS_NAMESPACE，保持 PUBLIC_ACCESS=0 并限制访问。由于会话及令牌已撤销，使用测试账号重新登录验证档案和战绩。Redis 保存带时效的在线状态、排队、路由和租约，不承担账号或战绩备份。通过演练后，由运营团队单独执行经过审查的切库流程。

## 中国大陆公开入口

公开环境启用前，需运营方确认出版、运营、实名与防沉迷、隐私、举报处理、备案和资源权利，以及从中国电信、联通、移动实际验证 HTTPS/WSS。未确认前保持公开入口关闭。客户端保留并使用仓库原有的 RoboMaster S1/EP URDF 加载流程，URDF、DAE 网格和贴图位于 public/models/robomaster，并随客户端构建提供。恢复原有资源不代表已完成授权核验；正式发布前仍由运营方核对最终发布包的资源清单、授权和品牌使用。

后端提供运营方接入点：由其将账号 ID 绑定官方实名核验结果。ELIGIBILITY_URL 指定 HTTPS 接口，以 Bearer ELIGIBILITY_TOKEN 认证 POST {playerId}；返回 {kind:"adult"}、{kind:"minor",permittedUntil:<UTC 毫秒>} 或 {kind:"denied"}。不可用、拒绝或无效响应均禁止参加对局。服务器还按北京时间的允许时段约束未成年结果，以本地窗口和运营接口截止时间中更早者为准；MINOR_HOLIDAYS 由运营方配置核对后的允许节假日日期，未配置的额外节假日按拒绝处理。PLAYTEST_HOLIDAYS 仅兼容私有模拟。入队、开局和重连核验资格，对局中持续复核，并按已知截止时间立即退出。该接入点仍需运营方正式联调。
