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

# 如何使用

## 0. 下载
已打包好的TeleSpider可在这里下载：[https://github.com/liesauer/TeleMediaSpider/releases](https://github.com/liesauer/TeleMediaSpider/releases)，包含 `Windows x64` `Linux x64` 多个版本，如需其他版本，请自行打包。

## 1. 首次运行
第一次运行时，会自动生成 `data/config.toml` 配置文件，需要配置以下内容：
<br />
`account.apiId`（参考文档）
<br />
`account.apiHash`（参考文档）
<br />
`account.account`（Telegram账号）
<br />
~~`account.session`~~（这个不需要填）

参考：
<br />
[Authentication | GramJS](https://gram.js.org/getting-started/authorization#getting-api-id-and-api-hash)

代理看情况配置，可参考[Using MTProxies and Socks5 Proxies.](https://gram.js.org/getting-started/authorization#using-mtproxies-and-socks5-proxies)。

## 2. 获取频道列表
```bash
TeleMediaSpider --list
```
列举出你账号加入的所有频道，复制频道ID，并打开 `data/config.toml` 配置文件，配置以下内容：
<br />
`spider.channels`

示例：
```toml
[spider]
channels = [ "频道id1", "频道id2" ]
```

如何抓取自己的已保存信息？
<br />
使用固定的频道id：`me` 即可，其他不变。

默认抓取频道的`图片` `视频` `音频` `文件`，如果你想特定的频道只抓取特定的数据，也可自由配置，有效值：`photo` `video` `audio` `file`。

将以下配置
```toml
[spider]
medias = { }
```
修改为
```toml
[spider]
  [spider.medias]
  频道id1 = "photo"
  频道id2 = "photo,video,audio,file"
```

## 3. 正式抓取
直接运行 `TeleMediaSpider`，爬虫将会自动抓取频道信息，自动获取新消息，支持断点续爬，可任意时刻随意关闭软件。

# 数据保存
所有数据都保存在 `data/{频道id}` 文件夹下，文件名格式：`{频道id}_{消息id}[_{原文件名}]`。
