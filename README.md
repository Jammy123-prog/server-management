# GPU Ops Center · GPU 集群管理台

轻量 Web 工具，专为小型 GPU 集群（3~20 台）设计。**Vue 3 + Vite 前端 / 零依赖 Node 后端**，一条命令启动。

| 核心诉求 | 实现 |
|---|---|
| 网页化管理各机器账号（增/删/改密/查） | 中心节点通过 SSH 在目标机器执行 `useradd / userdel / chpasswd`，账号落在机器本地 |
| 监控各台资源 | SSH 轮询 `nvidia-smi`、`/proc`、`free`、`df`：GPU 利用率/显存/温度/功耗、CPU/内存/磁盘、趋势曲线 |
| 各机器在线用户 + 谁在占卡 | 解析 `nvidia-smi --query-compute-apps` + `ps`，按用户展示"谁在占哪张卡、占了多少显存" |

**旁路设计**：GPU 机器上零安装、零 agent。中心节点宕机时，所有 GPU 机器的 SSH 登录和任务运行完全不受影响。

---

## 一、技术栈与目录

```
server/
├── package.json          # scripts: dev / build / start
├── vite.config.js        # Vite 配置（dev 代理 /api → 8601）
├── dev.mjs               # npm run dev：同时启动 API + Vite
├── index.html            # Vite 入口
├── config.json           # 运行配置（机器列表/密码/采集间隔）
├── audit.json            # 审计日志（运行时生成）
├── gpu-ops-center.service# systemd 开机自启（部署到中心节点用）
├── server/
│   └── api.mjs           # 后端：零 npm 依赖，Node >= 18
└── src/
    ├── main.js           # 入口 + v-rise 入场动画指令
    ├── style.css         # 设计系统（Ethereal Glass / Double-Bezel）
    ├── api.js            # fetch 封装 + 工具函数
    ├── App.vue           # 认证门 + 导航 + Toast
    ├── components/       # Sparkline / StatBar
    └── views/            # Login / Dashboard / Users / Audit
```

依赖极简：运行时仅 `vue`；开发期仅 `vite` + `@vitejs/plugin-vue`。无 Router、无状态库、无 UI 组件库。

## 二、本地启动

```bash
npm install

# 开发模式（Vite HMR 热更新 + API 8601）
npm run dev
# → http://localhost:5173

# 生产构建 + 启动（单进程，API + 静态文件同端口 8600）
npm run build
npm start
# → http://<本机IP>:8600
```

默认 `config.json` 开启了 `"demo_mode": true`（模拟数据，不连真实机器），可先预览全部界面。连真实机器时改为 `false`。

## 三、部署到中心节点（RK3588 / 任意 Linux，约 10 分钟）

### 1. 准备 SSH 免密 + 受限 sudo

管理台需要 SSH 免密连接每台 GPU 机器执行采集和账号操作。**推荐专用账号 + sudo 白名单**：

在中心节点上：

```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""
for h in 192.168.1.11 192.168.1.12 192.168.1.13 192.168.1.14 192.168.1.15; do
  ssh-copy-id $h
done
```

在**每台 GPU 机器**上（root 执行，一次性）：

```bash
useradd -m -s /bin/bash gpuops
mkdir -p /home/gpuops/.ssh && chmod 700 /home/gpuops/.ssh
echo "ssh-ed25519 AAAA...（中心节点公钥）" > /home/gpuops/.ssh/authorized_keys
chown -R gpuops:gpuops /home/gpuops/.ssh && chmod 600 /home/gpuops/.ssh/authorized_keys

# 只允许账号管理命令免密 sudo
cat > /etc/sudoers.d/gpuops <<'EOF'
gpuops ALL=(root) NOPASSWD: /usr/sbin/useradd, /usr/sbin/userdel, /usr/sbin/usermod, /usr/sbin/chpasswd
EOF
chmod 440 /etc/sudoers.d/gpuops
```

> 偷懒方案：`ssh-copy-id root@每台机器` + config.json `"ssh_user": "root"`。内网 5 台可接受，但不如受限方案稳妥。

#### 服务器目前都是密码登录？不影响，密码就是引导通道

已有密码账号不需要做任何改动（加公钥是纯增量操作，现有用户和密码不受影响），每台机器只需**输一次密码**完成引导：

```bash
# ① 中心节点生成密钥（已存在 ~/.ssh/id_ed25519 则跳过）
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N ""

# ② 用现有 root 密码一次性引导 gpuops 账号（建号 + 装公钥 + sudo 白名单）
PUB=$(cat ~/.ssh/id_ed25519.pub)
for h in 192.168.1.11 192.168.1.12 192.168.1.13 192.168.1.14 192.168.1.15; do
  ssh root@$h "useradd -m -s /bin/bash gpuops && \
    mkdir -p /home/gpuops/.ssh && echo '$PUB' > /home/gpuops/.ssh/authorized_keys && \
    chmod 700 /home/gpuops/.ssh && chmod 600 /home/gpuops/.ssh/authorized_keys && \
    chown -R gpuops:gpuops /home/gpuops/.ssh && \
    printf 'gpuops ALL=(root) NOPASSWD: /usr/sbin/useradd, /usr/sbin/userdel, /usr/sbin/usermod, /usr/sbin/chpasswd\n' > /etc/sudoers.d/gpuops && \
    chmod 440 /etc/sudoers.d/gpuops"
done   # 每台在这一步输一次现有密码即可

# ③ 验证：gpuops 免密登录 + 免密 sudo 均应直接成功
ssh gpuops@192.168.1.11 'sudo -n /usr/sbin/useradd --version >/dev/null && echo OK'
```

> **要不要关闭密码登录？** 建议暂不关闭——保留密码 = 多一条应急通道（密钥或中心节点出问题时仍可进任意机器），与旁路设计原则一致。系统稳定运行后再视需要在各机器 `/etc/ssh/sshd_config` 设 `PasswordAuthentication no`（改前务必先开新终端验证密钥登录可用）。

### 2. 部署项目

```bash
# 拷贝到中心节点
rsync -av --exclude node_modules --exclude dist ./ rk-center:/opt/gpu-ops-center/

# 中心节点安装 Node >= 18（RK3588 为 arm64）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

cd /opt/gpu-ops-center
npm install --omit=dev        # 生产只需 vue（后端零依赖）
npm run build                 # 构建前端到 dist/
```

### 3. 配置 config.json

```json
{
  "listen_host": "0.0.0.0",
  "listen_port": 8600,
  "admin_password": "改成你自己的强密码",
  "poll_interval": 10,
  "ssh_user": "gpuops",
  "ssh_port": 22,
  "demo_mode": false,
  "machines": [
    {"host": "gpu-01", "ip": "192.168.1.11"},
    {"host": "gpu-02", "ip": "192.168.1.12"},
    {"host": "gpu-03", "ip": "192.168.1.13"},
    {"host": "gpu-04", "ip": "192.168.1.14"},
    {"host": "gpu-05", "ip": "192.168.1.15"}
  ]
}
```

- `admin_password` 支持明文或 `sha256$<hex>` 哈希格式
- 机器列表也可以不在这里预先写全——部署后在网页"机器管理"页随时增删，自动保存回 `config.json`
- 注意：生产模式（`npm start`）需要 `npm run build` 产物；只有后端源码也能跑，但页面会提示用 dev 端口

### 4. 启动 / 开机自启

```bash
# 直接启动
npm start

# 或 systemd
sudo cp gpu-ops-center.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now gpu-ops-center
```

浏览器访问 `http://<中心节点IP>:8600/`。

## 四、使用说明

- **总览**：统计卡（在线机器 / GPU 平均利用率 / 显存占用 / 活跃用户）→ 每台机器卡片（GPU、CPU/内存/磁盘、趋势曲线、"用户 N / 占卡 N"徽标）→ 展开看 GPU 进程明细和登录用户 → 底部全集群占卡进程表。**搜索框**支持按机器名或 IP 过滤机器卡片；机器超过 8 台（4 行）时卡片区自动改为内部滚动浏览
- **机器管理**：网页上增删受管机器（名称 + IP），支持先"测试连接"验证 SSH 免密可达；改动自动写入 `config.json` 并立即生效，无需重启服务。新增机器只需在中心节点对新机器做一次 `ssh-copy-id`（或密码引导，见第三章）
- **密码引导**：采集失败且报 `Permission denied` 时，总览页 / 机器管理页出现"密码引导接入"按钮——输入目标机器一次登录密码（root 或有 sudo 权限的账号），中心节点自动完成 gpuops 建号 + 公钥安装 + 受限 sudo 配置，随后立即重新采集。密码仅当次使用、不落盘，操作记入审计。要求中心节点 OpenSSH >= 8.4（Ubuntu 22.04 / Debian 12 默认满足，`ssh -V` 可查）
- **用户管理**：填用户名 → 生成密码 → 勾选机器（支持全选）→ 可选 sudo → 创建；**机器×用户矩阵**每台一张卡，悬停用户行出现"改密 / 删除"
- **操作审计**：所有账号操作持久化到 `audit.json`，含每台机器的成败与失败原因、操作管理员

## 五、故障域说明（重要）

| 场景 | 影响 |
|---|---|
| **中心节点宕机** | 仅管理台不可访问，GPU 机器 SSH 登录和任务**完全不受影响**（账号在机器本地） |
| 某台 GPU 机器宕机 | 该机器卡片显示离线与错误原因，其余正常 |
| GPU 机器重装系统 | 重做一次 SSH 配置（第三章第 1 步），管理台无需改动 |

> 请勿与 FreeIPA/LDAP 等集中认证混用——那会让认证服务成为登录单点故障，违背本方案旁路设计原则。

## 六、安全说明

- 管理员登录（用户名 + 密码）+ HttpOnly 会话 Cookie，5 次错误锁定 5 分钟；管理员密码加盐哈希存于 `admins.json`，首次启动自动用 `config.json` 的 `admin_password` 创建默认账号 `admin`
- 仅建议内网使用；公网访问请自行加反向代理 + HTTPS
- 管理账号 sudo 仅限 useradd/userdel/usermod/chpasswd 四条命令

## 七、常见问题

**Q：为什么选 Vue 不选 React？**
A：这个体量的界面用 Vue 3 运行时更小（~34KB）且无需 Router/Pinia/组件库；React 生态通常要叠加更多库才能达到同等开发体验。

**Q：轮询对 GPU 机器有开销吗？**
A：每 10 秒一次 SSH + 几条查询命令，可忽略。`poll_interval` 最低不建议小于 5 秒。

**Q：一台机器多张卡支持吗？**
A：支持，采集脚本天然多卡，趋势曲线取各卡平均。

**Q：API 端口和前端端口？**
A：`npm run dev` 时 API=8601、前端=5173（Vite 代理）；`npm start` 时统一 8600。

**Q：忘记管理密码？**
A：编辑 `config.json` 的 `admin_password`，重启服务。
