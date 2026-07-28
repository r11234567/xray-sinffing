# xray-sinffing

Xray 双向流量统计、日报、周报、月报和 Telegram Bot 通知。程序读取 Xray 官方 Stats API，按 client email 统计用户总流量，并在路由可以确定时统计用户经过的出口。

English documentation is included below the Chinese documentation.

## 中文

### 功能与边界

- 通过 `xray api statsquery` 读取上行和下行计数器，不解析访问日志。
- 用户名取 client email 中 `@` 前的部分；多个 email 的前缀相同会合并。
- 统计每个用户总流量、本机各出口总流量，以及可确定归属时的用户-出口流量。
- Xray Stats API 本身没有“用户乘出口”二维统计。程序只使用 inbound 路由到单个 `outboundTag` 的确定映射，或 `track.emailOutbounds` 的显式映射；balancer、域名/IP 动态路由等无法确定的流量显示为“未归属”，不猜测、不按比例分摊。
- 按 Xray routing 文档，没有规则匹配时流量由 `outbounds` 数组的第一个 outbound 发出。第二个 `freedom/direct` 不会因为第一个出口失败而自动接管；自动故障切换需要单独配置 balancer/observatory 等机制。
- 每个 Xray client 建议使用唯一完整 email。重复完整 email 会合并 Stats 计数，并在报告中提示。
- systemd 服务默认以非 root 的 `xraystat` 用户运行；安装器需要 root 或 sudo 仅用于安装、读取 Xray 配置和管理服务。

实现依据：[Xray RoutingObject](https://xtls.github.io/config/routing.html) 和 [Xray PolicyObject](https://xtls.github.io/config/policy.html)。前者定义未匹配规则时使用第一个 outbound，后者分别定义 user 与 system inbound/outbound Stats 开关。

### 一键安装

安装并补齐 Xray Stats/API 配置：

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ install
```

只安装 reporter、不修改 Xray：

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ install --no-patch-xray
```

更新到最新版并保留现有配置、历史状态：

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ update
```

`install` 在已安装机器上重复执行也会覆盖程序为最新版；`update` 是语义更明确的同类操作。两者默认都会检查并补齐 Xray Stats/API、所有 client policy level 和 Xray 配置读取权限，然后重启服务。Xray 配置目录规范为 `755`、配置文件规范为 `644`，普通用户可读但不可写。只更新 reporter 可加 `--no-patch-xray`。程序不会创建无人值守的定时自动更新任务。

如果旧报告曾在“Xray 配置不可读”或“某个 policy level 未启用 user Stats”期间累计，旧状态缺少一侧计数器，无法事后还原。使用下面的命令可在更新成功后备份旧状态，并从新的 Xray 计数器基线开始：

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ update --reset-state
```

旧文件保存在 `/var/lib/xray-sinffing/traffic-state.json.bak-reset-时间戳`，不会直接删除。

远程卸载 reporter 和 systemd 服务（保留配置与历史状态）：

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ uninstall
```

本地源码安装或卸载：

```bash
sudo ./install.sh install
sudo ./install.sh uninstall
```

安装器会创建 `xraystat` 系统用户、安装到 `/opt/xray-sinffing`、创建 `/etc/xray-sinffing/config.json`，并按需要备份和修改 Xray 配置以启用 Stats API。安装器会扫描所有 client 的 `level`，为每个实际使用的 policy level 启用 `statsUserUplink` 和 `statsUserDownlink`。Xray 配置修改前会先备份，修改后使用 Xray 自带测试命令校验。

### 配置

安装后编辑：

```bash
sudo nano /etc/xray-sinffing/config.json
sudo systemctl restart xray-sinffing.service
```

下面是完整的、可作为起点的配置。`YOUR_...` 是示例值，安装后在本机 `/etc/xray-sinffing/config.json` 中填写实际值。

```json
{
  "xray": {
    "binary": "/usr/local/bin/xray",
    "apiServer": "127.0.0.1:10085",
    "configPath": "/usr/local/etc/xray/config.json"
  },
  "runtime": {
    "statePath": "/var/lib/xray-sinffing/traffic-state.json",
    "timezone": "Asia/Shanghai",
    "sampleIntervalSeconds": 300,
    "initialSnapshotOnly": true,
    "retentionDays": 120
  },
  "telegram": {
    "botToken": "YOUR_TELEGRAM_BOT_TOKEN",
    "chatId": "YOUR_TELEGRAM_CHAT_ID",
    "topicId": null
  },
  "komari": {
    "probeUrl": "https://monitor.example.invalid/instance/INSTANCE_ID",
    "brandName": "Xray Traffic Report",
    "nodeName": "node-1"
  },
  "track": {
    "outbounds": [],
    "userAliases": {},
    "emailOutbounds": {},
    "includeUntrackedOutbounds": false,
    "forceShowOutboundNames": false,
    "excludeOutbounds": ["api", "block"]
  },
  "reports": {
    "daily": {
      "enabled": true,
      "time": "00:05",
      "reportPreviousPeriod": true
    },
    "weekly": {
      "enabled": true,
      "weekday": 1,
      "time": "00:10",
      "reportPreviousPeriod": true
    },
    "monthly": {
      "enabled": true,
      "day": 1,
      "time": "00:15",
      "reportPreviousPeriod": true
    }
  }
}
```

#### `xray`

- `binary`：Xray 可执行文件路径。
- `apiServer`：Xray Stats API 地址，必须与 Xray 的 `api` 入站和 `stats` 配置一致。
- `configPath`：Xray 实际加载的单个 JSON 文件或 `-confdir` 目录。安装器会从 `xray.service` 的 `ExecStart` 自动识别；reporter 使用官方 `xray run -dump` 读取合并后的有效配置，从中发现 client email、inbound、outbound 和 routing。
- Xray inbound 的 `tag` 是可选字段；没有 `tag` 不会导致 client email 被忽略。程序会使用内部索引识别该 inbound，并按默认 outbound 或可匹配的专属规则归属。

#### `runtime`

- `statePath`：累计状态文件，包含上次 API 计数器和日报状态。
- `timezone`：采样周期、日报/周报/月报边界使用的 IANA 时区。
- `sampleIntervalSeconds`：采样和检查发送任务的间隔；实际发送最多比设定时间晚一个间隔。
- `initialSnapshotOnly`：首次启动只保存当前 Xray 计数器基线，不把安装前流量计入当前周期。设为 `false` 时，首次启动会把当前计数器当作从零开始的增量。
- `retentionDays`：保留多少天的日报状态；过期日报桶会被清理。周报和月报由其周期状态保留。

#### `telegram` 与 `komari`

- `telegram.botToken`：BotFather 生成的 Bot Token。
- `telegram.chatId`：接收消息的用户、群组或频道 ID。
- `telegram.topicId`：论坛群组的 Topic ID；没有 Topic 时使用 `null`。
- `komari.probeUrl`：报告中的 Dashboard 按钮链接；留空则不显示按钮。
- `komari.brandName`：消息顶部品牌名。
- `komari.nodeName`：节点显示名；留空时使用本机 hostname。

#### `track`

- `outbounds`：为自动发现的有效出口设置筛选和显示名，例如 `[ { "tag": "proxy-a", "name": "主出口" } ]`。未被默认出口、inbound 专属规则或专属 balancer 使用的 tag 即使写在这里也不会强行进入报告。
- `outbounds: []`：自动发现“主出口”，包括 Xray `outbounds` 数组中的首个默认出口，以及带 `inboundTag` 的 inbound 专属 `outboundTag`；inbound 专属 balancer 会按 selector 找到匹配出口。没有 `inboundTag` 的全局 IP/domain 规则只影响实际路由，不会被冒充成所有用户的主出口。自动发现会排除 tag 为 `api`、`block`、`excludeOutbounds` 中的 tag，以及 protocol 为 `blackhole` 的出口。
- `userAliases`：可选显示名映射。键可以是完整 email 或 `@` 前的用户名，值是报告显示名；为空对象表示直接使用用户名。
- `emailOutbounds`：可选的显式归因映射，优先使用完整 email，例：`{ "user-a@example.invalid": "proxy-a" }`。也支持以用户名为键，但同名前缀的多个 email 会一起匹配，复杂配置应使用完整 email。
- `includeUntrackedOutbounds`：显式填写 `outbounds` 时，是否把自动发现但未列出的其他有效出口一并加入报告；默认 `false`。它不会加入无效、内部或 blackhole 出口。
- `forceShowOutboundNames`：只有一个有效出口时，是否仍显示出口名称和“按出口”分栏；默认 `false`，单出口报告会直接显示本机和用户合计。
- `excludeOutbounds`：自动发现时额外排除的 outbound tag；默认排除 `api`、`block`。

报告会分别显示 Xray 的“出口合计”和“用户合计”，不会把两个独立计数器相减后虚构流量归属。没有流量的出口不会显示；真正启用了 user Stats 且没有流量的用户只显示一行 `0 B`。如果某个 client level 没有启用双向 user Stats，报告会明确显示“统计未启用”，不会错误地写成 `0 B`。

#### `reports`

- `daily.time`、`weekly.time`、`monthly.time`：按 `runtime.timezone` 解释的 24 小时制 `HH:MM`。
- `weekly.weekday`：1 表示周一，7 表示周日。
- `monthly.day`：每月发送日；不存在的日期不会触发，例如 31 日在 2 月不会发送。
- `enabled`：是否启用该报告。
- `reportPreviousPeriod`：定时任务设为 `true` 时发送刚结束的完整日/周/月；设为 `false` 时发送当前周期累计。命令行 `--report` 用于立即发送当前周期。

### 测试

查看服务和 Stats API：

```bash
systemctl status xray-sinffing.service --no-pager
/usr/local/bin/xray api statsquery --server=127.0.0.1:10085
```

只预览日报，不访问 Telegram：

```bash
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js \
  --config /etc/xray-sinffing/config.json --once --report daily --dry-run
```

发送实际的当前日报到 Telegram（不加 `--dry-run`）：

```bash
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js \
  --config /etc/xray-sinffing/config.json --once --report daily
```

只发送一次 Komari 风格模板测试消息：

```bash
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js \
  --config /etc/xray-sinffing/config.json --test-telegram
```

周报和月报可将 `--report daily` 改为 `weekly` 或 `monthly`。查看运行日志：

```bash
journalctl -u xray-sinffing.service -n 100 --no-pager
```

### 文件位置

- 程序：`/opt/xray-sinffing`
- 配置：`/etc/xray-sinffing/config.json`
- 状态：`/var/lib/xray-sinffing/traffic-state.json`
- systemd：`/etc/systemd/system/xray-sinffing.service`

## English

### What it does

`xray-sinffing` reads bidirectional counters from Xray's documented Stats API and sends daily, weekly, and monthly Telegram reports. It uses the part before `@` in each client email as the report username. Full emails with the same prefix are grouped under that username.

Xray does not expose a native user-by-outbound matrix. A user is assigned from an inbound-specific deterministic `outboundTag`, or from `track.emailOutbounds`. An inbound without such a rule uses Xray's first outbound, as documented by the routing module. Global IP/domain rules are not treated as the primary exit for every inbound. Balancers and dynamic routing are reported as unattributed instead of being guessed or split.

Xray does not automatically fail over from the first outbound to the second one. A `freedom/direct` entry becomes a fallback only when the Xray configuration explicitly implements that behavior with a balancer/observatory or another routing mechanism.

The systemd service runs as the unprivileged `xraystat` user. Root or sudo is required only for installation and service/Xray configuration management.

Implementation references: [Xray RoutingObject](https://xtls.github.io/config/routing.html) and [Xray PolicyObject](https://xtls.github.io/config/policy.html). They document the first-outbound default and the separate user/system traffic counters.

### Install and uninstall

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ install
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ install --no-patch-xray
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ uninstall
```

The installer creates the service user, installs the reporter, keeps a root-owned configuration readable by the service group, and validates any Xray configuration patch with Xray's own test command. Uninstall removes the application and service but keeps `/etc/xray-sinffing` and `/var/lib/xray-sinffing`.

Update while preserving the existing configuration and traffic state:

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ update
```

Running `install` again also refreshes the application. `update` is the explicit equivalent. Both verify Xray Stats/API, client policy levels, and reporter read access by default. The Xray configuration directory is normalized to mode `755` and the configuration file to `644`, making them readable but not writable by ordinary users. Add `--no-patch-xray` to refresh only the reporter. No unattended periodic update timer is installed.

If state was accumulated while the Xray configuration was unreadable or a client policy level lacked user Stats, the missing counter dimension cannot be reconstructed. Use `update --reset-state` to back up the old state and establish a clean baseline. Backups are kept as `/var/lib/xray-sinffing/traffic-state.json.bak-reset-TIMESTAMP`.

### Configuration

Edit `/etc/xray-sinffing/config.json`, using the complete JSON example in the Chinese section as the starting point, then restart `xray-sinffing.service`.

`xray` fields:

- `binary`: path to the Xray executable.
- `apiServer`: Xray Stats API listen address.
- `configPath`: the JSON file or `-confdir` directory actually loaded by Xray. The installer detects it from `xray.service` `ExecStart`, and the reporter uses official `xray run -dump` output to inspect the merged clients, inbounds, outbounds, and routing.
- An inbound `tag` is optional in Xray. Untagged inbounds are still scanned for client emails and receive an internal identity for attribution.

`runtime` fields:

- `statePath`: persistent counter baseline and report bucket file.
- `timezone`: IANA timezone for bucket boundaries and report schedules.
- `sampleIntervalSeconds`: traffic sampling and scheduler polling interval.
- `initialSnapshotOnly`: when `true`, the first run only saves a counter baseline, excluding traffic accumulated before installation. When `false`, the first run books current counters as traffic since zero.
- `retentionDays`: number of daily buckets to retain.

`telegram` and `komari` fields:

- `botToken`, `chatId`, and optional `topicId`: Telegram Bot API destination settings.
- `probeUrl`: dashboard button URL; leave it empty to omit the button.
- `brandName`: report header brand.
- `nodeName`: displayed node name; an empty value uses the hostname.

`track` fields:

- `outbounds`: filters smart-discovered effective outbounds and assigns display names. A tag that is not the default or used by an inbound-scoped rule/balancer is not forced into the report merely because it appears here.
- An empty `outbounds` discovers the first/default outbound plus inbound-scoped outbound rules and inbound-scoped balancers. Global IP/domain rules are excluded from primary user attribution. Automatic discovery excludes `api`, `block`, tags in `excludeOutbounds`, and `blackhole` protocol outbounds.
- `userAliases`: maps a full email or local username to a display name. An empty object keeps the username unchanged.
- `emailOutbounds`: explicit user traffic attribution from a full email (preferred) or local username to one outbound tag.
- `includeUntrackedOutbounds`: with an explicit list, append other smart-discovered effective outbounds. It does not re-enable excluded internal or blackhole outbounds.
- `forceShowOutboundNames`: show outbound sections even when there is only one effective outbound. The default single-outbound report shows totals without a redundant outbound label.
- `excludeOutbounds`: additional tags omitted by automatic discovery.

Reports display Xray's outbound total and user total as separate counter dimensions; they do not subtract one from the other and invent an attribution. Zero-flow outbound lines are omitted. A user is shown as `0 B` only when user Stats are enabled for that client's policy level; otherwise the report explicitly says that statistics are disabled. The installer enables bidirectional user Stats for every client level it discovers.

`reports` fields:

- `enabled`: enable that scheduled report.
- `time`: 24-hour `HH:MM` in `runtime.timezone`.
- `weekly.weekday`: Monday is 1 and Sunday is 7.
- `monthly.day`: day of month.
- `reportPreviousPeriod`: scheduled reports use the previous completed period when `true`, or the current accumulated period when `false`. A command-line `--report` sends the current period immediately.

### Tests

```bash
systemctl status xray-sinffing.service --no-pager
/usr/local/bin/xray api statsquery --server=127.0.0.1:10085
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js --config /etc/xray-sinffing/config.json --once --report daily --dry-run
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js --config /etc/xray-sinffing/config.json --once --report daily
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js --config /etc/xray-sinffing/config.json --test-telegram
```

The first report command is preview-only. The second sends a real current daily report. The third sends the integrated Komari-style test template. Use `weekly` or `monthly` in place of `daily` for those report types.
