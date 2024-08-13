import queue from 'async/queue';
import Cron from 'croner';
import { mkdirSync } from 'fs';
import { writeFile } from 'fs/promises';
import input from 'input';
import mimetics from 'mimetics';
import minimist from 'minimist';
import { Api, Logger, TelegramClient } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import xbytes from 'xbytes';

import { Tonfig } from '@liesauer/tonfig';

import {
    array2dictionary, consoletable, DataDir, ellipsisLeft, ellipsisMiddle, waitForever, waitTill
} from './functions';
import { AnnotatedDictionary, UnwrapAnnotatedDictionary } from './types';

const argv = minimist(process.argv.slice(2));

class MyLogger extends Logger {
    public format(message: string, level: string, messageFormat?: string) {
        return (messageFormat || this.messageFormat)
            .replace("%t", this.getDateTime())
            .replace("%l", level.toUpperCase())
            .replace("%m", message);
    }
    public log(level: LogLevel, message: string, color: string) {
        let multiLine = message.includes("\n");
        let messageFormat = "";

        if (multiLine) {
            messageFormat = "[%t] [%l]\n%m";
        } else {
            messageFormat = "[%t] [%l] - %m";
        }

        const log = color + this.format(message, level, messageFormat) + this['colors'].end;

        if (!uiTimer || uiTimer['_states'].paused) {
            console.log(log);
        }

        addLogHistory(log, message);
    }
}

function addLogHistory(message: string, raw: string) {
    if (logHistory.length && logHistory[logHistory.length - 1].includes(raw)) {
        logHistory[logHistory.length - 1] = message;
        return;
    }

    const messageLines = message.split("\n");

    if (messageLines.length == maxLogHistory) {
        logHistory = messageLines;
    } else if (messageLines.length > maxLogHistory) {
        logHistory = messageLines.slice(messageLines.length  - maxLogHistory);
    } else {
        for (const message of messageLines) {
            if (logHistory.length >= maxLogHistory) {
                logHistory.shift();
            }
            logHistory.push(message);
        }
    }
}

function workerErrorHandler(error: any, job: Cron) {
    logger.error(`「${job.name}」任务过程中发生错误：\n${error}`);
};

async function getChannelInfos(client: TelegramClient) {
    const dialogs = await client.invoke(
        new Api.messages.GetDialogs({
            offsetPeer: new Api.InputPeerEmpty(),
            limit: 500,
        })
    ) as Exclude<Api.messages.TypeDialogs, Api.messages.DialogsNotModified>;

    const ids = dialogs.dialogs.map(v => v.peer).filter(v => v.className == "PeerChannel").map(v => v as Api.PeerChannel);

    const idsMap = array2dictionary(ids, (i, e) => {
        return { key: e.channelId.toString(), value: e };
    });

    const channels = await client.invoke(new Api.channels.GetChannels({
        id: ids,
    }));

    const chats = channels.chats.filter(v => v.className == "Channel").map(v => v as Api.Channel);

    const getTopics = (topics: Api.messages.ForumTopics) => {
        return topics.topics.filter(v => v.className == "ForumTopic").map(v => v as Api.ForumTopic).map(v => ({
            id:    v.id,
            title: v.title,
        }));
    };

    const infos = chats.map(chat => {
        return {
            id:       chat.id || "",
            peer:     idsMap[chat.id.toString()] || "",
            title:    chat.title,
            forum:    chat.forum,
            username: chat.username,
            topics:   [] as ReturnType<typeof getTopics>,
        };
    });

    await Promise.allSettled(infos.filter(v => v.forum).map(async v => {
        return client.invoke(
            new Api.channels.GetForumTopics({
                channel: v.peer,
            })
        ).then(topics => ({ topics, channel: v }));
    })).then(results => {
        for (const result of results) {
            if (result.status == "rejected") continue;

            result.value.channel.topics = getTopics(result.value.topics);
        }
    });

    infos.unshift({
        id:       "me",
        peer:     "me",
        title:    "Saved Messages",
        forum:    false,
        username: "",
        topics:   [],
    });

    return infos;
}

/**
 * @param lastId 获取此条信息以后的信息
 * @param limit 每次获取多少信息（最大100）
 * @param newStrategy 当采集新的群组时（既没有`lastId`），历史信息采集策略
 * 
 * -1：采集所有历史信息，0：不采集任何历史信息，正数字：采集最后指定数量信息
 */
async function getChannelMessages(client: TelegramClient, channelId: string, lastId?: number, limit: number = 100, newStrategy: number = -1) {
    let messages: Api.MessageService[] = [];

    if (lastId) {
        do {
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    addOffset: -1 - limit,
                    offsetId: lastId,
                    limit: limit,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                messages.push(..._messages.messages.map(v => v as Api.MessageService).reverse());
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);
    } else if (newStrategy === -1) {
        let page = 0;

        do {
            // 第一次获取第一条信息，后面正常取
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    offsetId: 1,
                    addOffset: -1,
                    limit: 1,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            page++;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                messages.push(..._messages.messages.map(v => v as Api.MessageService));
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;
            if (newStrategy && newStrategy !== -1 && messages.length >= newStrategy) {
                messages = messages.slice(0, newStrategy);
                break;
            }

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);

        messages.reverse();
    } else if (newStrategy >= 0) {
        let page = 0;

        do {
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    addOffset: page * limit,
                    limit: newStrategy === 0 ? 1 : limit,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            page++;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                if (newStrategy !== 0) {
                    messages.push(..._messages.messages.map(v => v as Api.MessageService));
                }
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;
            if (newStrategy && newStrategy !== -1 && messages.length >= newStrategy) {
                messages = messages.slice(0, newStrategy);
                break;
            }

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);

        messages.reverse();
    }

    return { lastId: lastId || 0, messages };
}

async function downloadChannelMedia(client: TelegramClient, channelId: string, message: Api.MessageService, channelInfo: UnwrapAnnotatedDictionary<typeof waitQueue>, medias?: string[]) {
    const photo = message.photo as Api.Photo;
    const video = message.video as Api.Document;
    const audio = message.audio as Api.Document;
    const file  = message.document && message.document.attributes.length == 1 && message.document.attributes[0].className == "DocumentAttributeFilename" ? message.file : null;

    const topicId = message.replyTo?.replyToTopId || message.replyToMsgId;

    if (photo && (!medias || medias.includes('photo'))) {
        let media = message.media as Api.MessageMediaDocument;

        const dir = DataDir() + '/' + channelId.toString();

        mkdirSync(dir, { recursive: true });

        let filename = `${channelId.toString()}${topicId ? '_' + topicId : ''}_${message.id}`;
        let ext = '';
        let noExt = false;

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        const fullFileName = noExt ? filename : `${filename}.${ext || 'jpg'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        await writeFile(`${dir}/${fullFileName}`, buffer);
    }

    if (video && (!medias || medias.includes('video'))) {
        let media = message.media as Api.MessageMediaDocument;

        const dir = DataDir() + '/' + channelId.toString();

        mkdirSync(dir, { recursive: true });

        let filename = `${channelId.toString()}${topicId ? '_' + topicId : ''}_${message.id}`;
        let ext = '';
        let noExt = false;

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        const fullFileName = noExt ? filename : `${filename}.${ext || 'mp4'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        await writeFile(`${dir}/${fullFileName}`, buffer);
    }

    if (audio && (!medias || medias.includes('audio'))) {
        let media = message.media as Api.MessageMediaDocument;

        const dir = DataDir() + '/' + channelId.toString();

        mkdirSync(dir, { recursive: true });

        let filename = `${channelId.toString()}${topicId ? '_' + topicId : ''}_${message.id}`;
        let ext = '';
        let noExt = false;

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        const fullFileName = noExt ? filename : `${filename}.${ext || 'mp3'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        await writeFile(`${dir}/${fullFileName}`, buffer);
    }

    if (file && (!medias || medias.includes('file'))) {
        let media = message.media as Api.MessageMediaDocument;

        const dir = DataDir() + '/' + channelId.toString();

        mkdirSync(dir, { recursive: true });

        let filename = `${channelId.toString()}${topicId ? '_' + topicId : ''}_${message.id}`;
        let ext = '';
        let noExt = false;

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        const fullFileName = noExt ? filename : `${filename}.${ext || 'dat'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        await writeFile(`${dir}/${fullFileName}`, buffer);
    }
}

const listChannels = !!argv['list'];
let channelTable: any[] = [];
let maxLogHistory = 10;
let logHistory: string[] = [];

let logger: Logger = new MyLogger();
let client: TelegramClient;
let tonfig: Tonfig;

let uiTimer: Cron;
let mainTimer: Cron;
let mediaSpiderTimer: Cron;

let channelInfos: Awaited<ReturnType<typeof getChannelInfos>>;

const waitQueue: AnnotatedDictionary<{
    channelId: string,
    channelTitle: string,
    downloading: boolean,
    fileName: string,
    downloadedBytes: bigInt.BigInteger,
    totalBytes: bigInt.BigInteger,
    messages: Api.MessageService[],
    medias: string[],
}, "channelId"> = {};

let execQueue;

async function mediaSpider() {
    await client.connect();

    const allowChannels = tonfig.get<string[]>('spider.channels', []);

    for (const channel of channelInfos) {
        const channelId = channel.id.toString();
        const channelTitle = channel.title || '';

        if (!allowChannels.includes(channelId)) continue;

        /**
         * 因为频道信息都是启动时只获取一次
         * 那就没必要每回都写一遍
         * 在第一次时，写入频道名，避免不必要的频繁IO操作
         */
        if (!waitQueue[channelId]) {
            // 保存频道名
            tonfig.set(['spider', 'titles', channelId], channelTitle);
            await tonfig.save();
        }

        let medias = tonfig.get(['spider', 'medias', channelId], '');

        if (!medias) {
            medias = 'photo,video,audio,file';
            tonfig.set(['spider', 'medias', channelId], medias);
            await tonfig.save();
        }

        const mediasArr = medias.split(',').map(v => v.trim());

        if (!waitQueue[channelId]) {
            waitQueue[channelId] = {
                channelId: channelId,
                channelTitle: channelTitle,
                downloading: false,
                fileName: '',
                downloadedBytes: null,
                totalBytes: null,
                messages: [],
                medias: mediasArr,
            };
        }

        /**
         * 如果这个频道的数据还没有抓取完
         * 就不再抓取新的信息
         * 
         * 因为要保存频道的最后抓取位置
         * 单个频道只能一条一条消息按顺序解析下载
         * 
         * 只做多频道单消息同时下载
         * 不做单频道多消息同时下载
         */
        if (waitQueue[channelId].messages.length) continue;

        const messages = await getChannelMessages(client, channelId, tonfig.get(['spider', 'lastIds', channelId], 0), undefined, -1);

        for (const message of messages.messages) {
            waitQueue[channelId].messages.push(message);

            execQueue.push();
        }
    }
}

async function render() {
    console.clear();

    if (listChannels) {
        if (channelTable && channelTable.length) {
            console.log(consoletable(channelTable));

            uiTimer.stop();
            return;
        }

        return;
    }

    const downloading = Object.values(waitQueue).filter(v => v.downloading == true && v.totalBytes && !v.totalBytes.isZero());

    {
        if (!downloading.length) {
            downloading.push({
                channelId: '',
                channelTitle: '',
                downloading: true,
                fileName: '',
                downloadedBytes: null,
                totalBytes: null,
                messages: null,
                medias: null,
            });
        }

        const tableData = downloading.map(v => {
            const channelTitle = ellipsisMiddle(v.channelTitle, 10);
            const fileName = ellipsisLeft(v.fileName, 15);

            let size = '';
            let percent = '';

            if (v.totalBytes && !v.totalBytes.isZero()) {
                const downloaded = v.downloadedBytes.toJSNumber();
                const total = v.totalBytes.toJSNumber();

                const dSize = xbytes(downloaded);
                const tSize = xbytes(total);

                size = `${dSize}/${tSize}`;
                percent = (downloaded / total * 100).toFixed(2) + '%';
                percent = percent.padStart(6, ' ');
            }

            return {
                "频道": channelTitle,
                "文件名": fileName,
                "进度": percent,
                "大小": size,
            };
        });

        console.log(consoletable(tableData));
    }

    for (const log of logHistory) {
        console.log(log);
    }
}

async function main() {
    logger = new MyLogger();

    tonfig = await Tonfig.loadFile(DataDir() + '/config.toml', {
        account: {
            apiId: 0,
            apiHash: '',
            session: '',
            account: '',
        },

        spider: {
            concurrency: 5,
            channels: [],
            titles: {},
            lastIds: {},
            medias: {},
        },

        proxy: {
            ip: "127.0.0.1",
            port: 0,
            username: "",
            password: "",
            MTProxy: false,
            secret: "",
            socksType: 5,
            timeout: 2,
        },
    });

    await tonfig.save();

    const apiId = tonfig.get<number>("account.apiId");
    const apiHash = tonfig.get<string>("account.apiHash");
    const account = tonfig.get<string>("account.account");

    if (!apiId || !apiHash || !account) {
        logger.warn('请编辑 data/config.toml 进行账号配置，并重启软件');
        await waitForever();
    }

    const proxy = {
        ip: tonfig.get<string>("proxy.ip", ""),
        port: tonfig.get<number>("proxy.port", 0),
        username: tonfig.get<string>("proxy.username", ""),
        password: tonfig.get<string>("proxy.password", ""),
        MTProxy: tonfig.get<boolean>("proxy.MTProxy", false),
        secret: tonfig.get<string>("proxy.secret", ""),
        socksType: tonfig.get<5 | 4>("proxy.socksType", 5),
        timeout: tonfig.get<number>("proxy.timeout", 2),
    };

    client = new TelegramClient(new StringSession(tonfig.get<string>("account.session", "")), apiId, apiHash, {
        baseLogger: logger,
        connectionRetries: 5,
        useWSS: false,
        proxy: proxy.ip && proxy.port ? proxy : undefined,
    });

    await client.start({
        phoneNumber: account,
        password: async () => await input.text("请输入密码："),
        phoneCode: async () => await input.text("请输入验证码："),
        onError: (err) => logger.error(err.message),
    });

    if (!tonfig.get<string>("account.session")) {
        tonfig.set("account.session", <string><unknown>client.session.save());

        await tonfig.save();
    }

    if (uiTimer) {
        uiTimer.resume();
    }

    channelInfos = await getChannelInfos(client);

    if (listChannels) {
        channelTable = [];

        for (const channel of channelInfos) {
            channelTable.push({
                "ID": channel.id.toString(),
                "频道名": channel.title,
            });
        }

        await waitForever();
    }

    const concurrency = tonfig.get<number>("spider.concurrency", 5);

    execQueue = execQueue || queue(async function(task, callback) {
        let channelInfo: UnwrapAnnotatedDictionary<typeof waitQueue>;

        await waitTill(() => {
            channelInfo = Object.values(waitQueue).find(v => !v.downloading && v.messages.length);

            return !!channelInfo;
        }, 100);

        channelInfo.downloading = true;

        const channelId = channelInfo.channelId;
        const message = channelInfo.messages[0];
        const mediasArr = channelInfo.medias;

        await downloadChannelMedia(client, channelId, message, channelInfo, mediasArr).then(async () => {
            channelInfo.messages.shift();

            // 下载成功，保存当前频道位置
            tonfig.set(['spider', 'lastIds', channelId], message.id);
            await tonfig.save();
        }, () => {
            // 下载失败，啥也不用管，后面根据队列自动重试
        }).finally(() => {
            channelInfo.downloading = false;

            callback();
        });
    }, concurrency);

    if (mediaSpiderTimer) {
        mediaSpiderTimer.stop();
        mediaSpiderTimer = null;
    }

    mediaSpiderTimer = Cron("*/10 * * * * *", {
        name: 'mediaSpider',
        protect: true,
        catch: workerErrorHandler,
    }, async () => await mediaSpider());

    await waitForever();
}

uiTimer = Cron("*/2 * * * * *", {
    name: 'ui',
    protect: true,
    paused: true,
    catch: workerErrorHandler,
}, async () => await render());

mainTimer = Cron("*/5 * * * *", {
    name: 'main',
    protect: true,
    catch: workerErrorHandler,
}, async () => await main());

mainTimer.trigger();
