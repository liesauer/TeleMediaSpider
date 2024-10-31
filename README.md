# TeleMediaSpider
Telegram 频道爬虫

![屏幕截图](screenshot.jpg)

# 初始化
```bash
yarn
```

# 如何调试
`VS Code` 中直接F5运行 `Launch`。

# 如何打包
`VS Code` 中运行 `pack executable` 任务，可执行文件会生成到 `output` 目录下。

<br />
<br />
<br />
<br />

# 如何使用

## 0. 下载
已打包好的TeleSpider可在这里下载：[https://github.com/liesauer/TeleMediaSpider/releases](https://github.com/liesauer/TeleMediaSpider/releases)，包含 `Windows x64` `Linux x64` 多个版本，如需其他版本，请自行打包。

## 1. 首次运行
直接运行，根据提示进行账号配置，配置以下内容：
<br /><br />
`account.apiId`（参考文档，[Getting API ID and API HASH | GramJS](https://gram.js.org/getting-started/authorization#getting-api-id-and-api-hash)）
<br />
`account.apiHash`（参考文档，[Getting API ID and API HASH | GramJS](https://gram.js.org/getting-started/authorization#getting-api-id-and-api-hash)）
<br />
`account.account`（Telegram账号，**需要加上区号**，比如中国大陆就是：+861xxxxxxxxxx，其他区域同理）
<br />
~~`account.session`~~（这个不需要填，登录后自动保存）

配置保存后，根据提示进行登录（仅第一次需要）

## 2. 配置频道列表

登录成功后，根据提示进行频道配置，配置以下内容：
<br /><br />
`spider.channels`

**频道id可以在频道列表文件 `data/channels.txt` 中找到并复制**

配置保存后，就会自动开始抓取了。

示例：

```toml
[spider]
channels = [ "频道id1", "频道id2" ]
```

**如何抓取自己的已保存信息？**
<br />
使用固定的频道id：`me` 即可。

默认抓取频道的`图片` `视频` `音频` `文件`，如果你想特定的频道只抓取特定的数据，也可自由配置，有效值：`photo` `video` `audio` `file`。

将以下配置

```toml
  [spider.medias]
  _ = "photo,video,audio,file"
```

修改为

```toml
  [spider.medias]
  频道id1 = "photo"
  频道id2 = "photo,video,audio,file"
```

## 3. 开始抓取
配置完账号信息、频道列表后，就会自动开始抓取啦，智能获取新消息，支持断点续抓，可任意时候随意关闭软件。

## 4. 并发下载
**注意：这并不是传统意义上的并发下载，而是指多频道同时下载，单一频道只能一条一条信息从前往后解析下载。**

将以下配置

```toml
[spider]
concurrency = 5
```

修改为你想要的多频道同时下载数，默认为5个频道同时下载。

## 5. 大小过滤
默认抓取大小不超过10GB的文件，如有需求，可按全局配置或按频道配置文件大小过滤。

格式：`下限-上限`
<br />
单位：`字节`
<br />
进制：`1024`
<br />
示例：`102400-10485760`
<br />
解释：抓取文件大小在 `100KB ~ 10MB` 之间的文件（含）

优先级：`频道配置 > 全局配置`

### 5.1. 全局配置
修改以下配置即可

```toml
[filter.default]
photo = "0-10737418240"
video = "0-10737418240"
audio = "0-10737418240"
file = "0-10737418240"
```

### 5.2. 频道配置
修改以下配置即可

```toml
[filter.photo]
频道id1 = "102400-999999999"

[filter.video]
频道id1 = "102400-999999999"

[filter.audio]
频道id1 = "102400-999999999"

[filter.file]
频道id1 = "102400-999999999"
```

## 代理设置
参考：
<br />
[Using MTProxies and Socks5 Proxies](https://gram.js.org/getting-started/authorization#using-mtproxies-and-socks5-proxies)

# 配置说明

**除了第一次配置账号信息，修改任意配置都需要重启软件生效**

**配置文件中所有的 `_` 配置项都是占位，用来当成示例配置供参考填写的，删除无实际影响。**

# 数据保存
默认下，同一条消息中的多张图片/文件会视为独立的文件，平级存放在数据文件夹中。
所有数据都保存在 `data/{频道id}[/_{子组id}]` 文件夹下，文件名格式：`[{聚合id}_]{消息id}[_{原文件名}]`。

## 消息聚合
```toml
[spider]
groupMessage = true
```

当开启消息聚合后，这些文件会放在子文件夹中。
即保存在 `data/{频道id}[/_{子组id}][/{聚合id}]` 文件夹下，文件名格式：`{消息id}[_{原文件名}]`。
