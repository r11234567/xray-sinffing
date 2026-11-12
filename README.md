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

更新后立即重发刚结束的完整周报区间：

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ update --no-patch-xray --resend-weekly
```

月报的对应命令是 `update --no-patch-xray --resend-monthly`。恢复命令会暂时停止 reporter，按上次发送边界到本次发送边界重新汇总日报，Telegram 成功后写入该完整区间的调度标记，再启动服务。普通 `--report` 和测试命令仍不会写标记。

`install` 在已安装机器上重复执行也会覆盖程序为最新版；`update` 是语义更明确的同类操作。两者默认都会检查并补齐 Xray Stats/API、所有 client policy level 和配置读取权限，然后重启服务。安装器保留 Xray 配置已有的非 root 属组，将 reporter 用户加入该组，并补齐组读取/目录遍历权限；已有的 `750 root:xray` 目录和 `640 root:xray` 文件保持原权限。root 属组的配置会改用 Xray 服务用户组（Xray 以 root 运行时使用 reporter 组），不会把 reporter 加入 root 组。`/etc/xray-sinffing` 目录仍使用 `755`、其 JSON 配置使用 `644`。只更新 reporter 并修复读权限可加 `--no-patch-xray`，这不会修改 Xray JSON 或重启 Xray。程序不会创建无人值守的定时自动更新任务。

如果日报提示 `EACCES: permission denied, stat '/usr/local/etc/xray/config.json'`，先在每台受影响机器执行下面的更新。更新保留 Telegram 配置与历史流量，不需要卸载或重置状态：

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ update --no-patch-xray
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js \
  --config /etc/xray-sinffing/config.json --check-config
sudo systemctl status xray-sinffing.service --no-pager
```

`--check-config` 使用当前用户调用 Xray 解析完整配置（含 `-confdir` 分片），成功输出 `Xray config OK`，失败返回非零状态；它不会采样、写入流量状态或发送 Telegram。安装器和 systemd 启动前都执行这项检查。不要用 `sudo node ... --check-config` 验证 reporter 权限：root 能读取不代表 `xraystat` 能读取。后续如果更改配置属组或服务用户，需要重新运行更新；若仍失败，使用 `namei -l /usr/local/etc/xray/config.json` 检查父目录权限，并查看 `journalctl -u xray-sinffing.service -n 30 --no-pager`。

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
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js \
  --config /etc/xray-sinffing/config.json --once --report daily --dry-run
sudo systemctl restart xray-sinffing.service
```

第二条命令会在不发送 Telegram 的情况下校验配置并预览日报；确认成功后再重启服务，避免 JSON 写错导致 systemd 反复重启。

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
    "outbounds": [
      { "tag": "proxy-a", "name": "主出口" },
      { "tag": "home-out", "name": "家宽出口" }
    ],
    "userAliases": {
      "alice@example.invalid": "Alice",
      "bob": "Bob"
    },
    "emailOutbounds": {
      "alice@example.invalid": "proxy-a"
    },
    "includeUntrackedOutbounds": false,
    "forceShowOutboundNames": false,
    "excludeOutbounds": ["api", "block"]
  },
  "reports": {
    "daily": {
      "enabled": true,
      "time": "00:05"
    },
    "weekly": {
      "enabled": true,
      "weekday": 1,
      "time": "00:10"
    },
    "monthly": {
      "enabled": true,
      "day": 1,
      "time": "00:15"
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

- `outbounds`：显式列出要显示的有效出口，并用 `name` 设置报告名称。示例中的 `proxy-a`、`home-out` 只是公开占位 tag，必须替换成你自己的 Xray outbound tag。
- `outbounds: []`：改为空数组后自动发现“主出口”：Xray `outbounds` 数组中的首个默认出口、带 `inboundTag` 的专属 `outboundTag`，以及专属 balancer 的 selector 命中出口。全局 IP/domain 规则不会被冒充成所有用户的出口；`api`、`block`、`excludeOutbounds` 和 `blackhole` 出口会排除。
- `userAliases`：这是 JSON 对象映射，不是对象数组。键可以是完整 email 或 `@` 前的用户名，值是报告显示名；例如 `"bob": "Bob"`。使用 `{}` 表示不改名，直接显示 email 的 `@` 前部分。
- `emailOutbounds`：这是 JSON 对象映射，不是对象数组。键是完整 email（推荐）或用户名，值必须是 Xray outbound tag；例如 `"alice@example.invalid": "proxy-a"`。只在自动路由无法唯一确定出口时填写。
- `includeUntrackedOutbounds`：显式填写 `outbounds` 时，`true` 会追加自动发现但未列出的有效出口；`false` 只显示显式列表。它不会加入内部或 blackhole 出口。
- `forceShowOutboundNames`：只有一个有效出口时，是否仍显示出口名称和“按出口”分栏；默认 `false`，单出口报告会直接显示本机和用户合计。
- `excludeOutbounds`：自动发现时额外排除的 outbound tag；默认排除 `api`、`block`。

报告会分别显示 Xray 的“出口合计”和“用户合计”，不会把两个独立计数器相减后虚构流量归属。没有流量的出口不会显示；真正启用了 user Stats 且没有流量的用户只显示一行 `0 B`。如果某个 client level 没有启用双向 user Stats，报告会明确显示“统计未启用”，不会错误地写成 `0 B`。

#### `reports`

- `daily.time`、`weekly.time`、`monthly.time`：按 `runtime.timezone` 解释的 24 小时制 `HH:MM`。
- `weekly.weekday`：1 表示周一，7 表示周日。
- `monthly.day`：每月发送日；若当月不存在该日期，则使用当月最后一天，例如 `31` 在 2 月按 2 月最后一天发送。
- `enabled`：是否启用该报告。
- 报告周期由发送日期直接定义，不使用自然周或自然月。日报汇总前一日；周报统计上次 `weekly.weekday` 到本次；月报统计上月 `monthly.day` 到本月同一日期。例如每月 5 日发送，就汇总上月 5 日（含）到本月 5 日（不含）之间保存的日报。`time` 控制当天几点发送。
- 周报和月报在发送时从日报桶重新汇总，因此同一天的流量必然同时进入对应周/月报告。安装或状态重置之前没有保存的日报无法还原；这种区间会明确显示实际采样覆盖，不会把缺失数据臆造成流量。

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

`--report` 是手动发送，无论是否带 `--dry-run` 都不会占用定时任务的“已发送”标记。`--test-telegram` 只发送测试模板，`--once` 只采样一次，它们也不会占用标记。只有 systemd 守护进程按配置时间自动发送且 Telegram API 返回成功后，才会记录该周期为已发送。

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

The installer creates the service user, installs the reporter, keeps `/etc/xray-sinffing` at mode `755` and its JSON configuration at mode `644`, and validates any Xray configuration patch with Xray's own test command. Uninstall removes the application and service but keeps `/etc/xray-sinffing` and `/var/lib/xray-sinffing`.

Update while preserving the existing configuration and traffic state:

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ update
```

Update and immediately resend the latest completed weekly send-to-send interval:

```bash
bash -c "$(curl -fsSL https://github.com/r11234567/xray-sinffing/raw/main/install.sh)" @ update --no-patch-xray --resend-weekly
```

Use `--resend-monthly` for the latest completed monthly interval. Recovery stops the reporter, rebuilds the interval from daily buckets, records the completed boundary only after Telegram accepts the report, and restarts the service. Ordinary manual and test commands still do not consume scheduler markers.

Running `install` again also refreshes the application. `update` is the explicit equivalent. Both verify Xray Stats/API, client policy levels, and reporter read access by default. The installer keeps existing non-root Xray config groups, adds the reporter to them, and grants group read/directory traversal access. Existing `750 root:xray` directories and `640 root:xray` files keep their permissions. Root-group configs use the Xray service user's group, or the reporter group when Xray runs as root; the reporter is never added to the root group. `/etc/xray-sinffing` remains mode `755` with mode `644` JSON files. Add `--no-patch-xray` to update the reporter and repair read access without changing Xray JSON or restarting Xray. No unattended periodic update timer is installed.

For an `EACCES` config error, run `update --no-patch-xray` on each affected machine. It preserves Telegram settings and traffic history. Then verify access as the service user:

```bash
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js \
  --config /etc/xray-sinffing/config.json --check-config
sudo systemctl status xray-sinffing.service --no-pager
```

`--check-config` parses the full Xray config, including confdir fragments, without sampling, saving state, or sending Telegram. Both the installer and the systemd pre-start check use it. A successful root check does not prove the reporter has access: use the configured runtime user (default `xraystat`). Rerun the update after changing config groups or service users. For remaining errors, inspect parent permissions with `namei -l` and the reporter journal.

If state was accumulated while the Xray configuration was unreadable or a client policy level lacked user Stats, the missing counter dimension cannot be reconstructed. Use `update --reset-state` to back up the old state and establish a clean baseline. Backups are kept as `/var/lib/xray-sinffing/traffic-state.json.bak-reset-TIMESTAMP`.

### Configuration

Edit `/etc/xray-sinffing/config.json` using this complete public example and replace every example value with your own value. Before restarting, run the preview command from the Tests section; it validates the configuration without sending Telegram and prevents a malformed JSON file from entering a systemd restart loop.

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
    "outbounds": [
      { "tag": "proxy-a", "name": "Primary" },
      { "tag": "home-out", "name": "Home" }
    ],
    "userAliases": {
      "alice@example.invalid": "Alice",
      "bob": "Bob"
    },
    "emailOutbounds": {
      "alice@example.invalid": "proxy-a"
    },
    "includeUntrackedOutbounds": false,
    "forceShowOutboundNames": false,
    "excludeOutbounds": ["api", "block"]
  },
  "reports": {
    "daily": { "enabled": true, "time": "00:05" },
    "weekly": { "enabled": true, "weekday": 1, "time": "00:10" },
    "monthly": { "enabled": true, "day": 1, "time": "00:15" }
  }
}
```

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

- `outbounds`: explicitly lists effective outbound tags and display names. `proxy-a` and `home-out` above are public placeholders and must be replaced.
- Set `outbounds` to `[]` for automatic discovery of the first/default outbound, inbound-scoped rules, and inbound-scoped balancer selectors. Global IP/domain rules are not used as primary user attribution. `api`, `block`, excluded tags, and blackhole outbounds are omitted.
- `userAliases`: a JSON object mapping a full email or local username to a display name, not an array. `{}` keeps the local username unchanged.
- `emailOutbounds`: a JSON object mapping a full email (preferred) or local username to one outbound tag. `{}` means no manual overrides.
- `includeUntrackedOutbounds`: with an explicit list, `true` appends other smart-discovered effective outbounds; `false` keeps only the list. It does not re-enable excluded internal or blackhole outbounds.
- `forceShowOutboundNames`: show outbound sections even when there is only one effective outbound. The default single-outbound report shows totals without a redundant outbound label.
- `excludeOutbounds`: additional tags omitted by automatic discovery.

Reports display Xray's outbound total and user total as separate counter dimensions; they do not subtract one from the other and invent an attribution. Zero-flow outbound lines are omitted. A user is shown as `0 B` only when user Stats are enabled for that client's policy level; otherwise the report explicitly says that statistics are disabled. The installer enables bidirectional user Stats for every client level it discovers.

`reports` fields:

- `enabled`: enable that scheduled report.
- `time`: 24-hour `HH:MM` in `runtime.timezone`.
- `weekly.weekday`: Monday is 1 and Sunday is 7.
- `monthly.day`: day of month.
- If `monthly.day` does not exist in a month, delivery uses that month's final day; for example, day `31` maps to the last day of February.
- Report intervals are defined by configured send dates rather than calendar weeks or months. Daily aggregates the previous date; weekly covers the previous configured weekday through the current one; monthly covers the previous configured day-of-month through the current one. A report sent on day 5 therefore aggregates daily buckets from the previous day 5 (inclusive) to the current day 5 (exclusive). `time` controls when delivery runs on that date.
- Weekly and monthly reports are rebuilt from daily buckets at delivery time, so every daily total is included in the matching aggregate interval. Data from before installation or a state reset cannot be reconstructed and is never invented.

### Tests

```bash
systemctl status xray-sinffing.service --no-pager
/usr/local/bin/xray api statsquery --server=127.0.0.1:10085
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js --config /etc/xray-sinffing/config.json --once --report daily --dry-run
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js --config /etc/xray-sinffing/config.json --once --report daily
sudo -u xraystat node /opt/xray-sinffing/bin/xray-sinffing.js --config /etc/xray-sinffing/config.json --test-telegram
```

The first report command is preview-only. The second sends a real current daily report. The third sends the integrated Komari-style test template. Use `weekly` or `monthly` in place of `daily` for those report types.

Manual `--report` commands never consume scheduler markers, with or without `--dry-run`. `--test-telegram` sends only the test template, while `--once` only samples counters. A period is marked as sent only when the systemd daemon performs its scheduled delivery and Telegram accepts the message.
