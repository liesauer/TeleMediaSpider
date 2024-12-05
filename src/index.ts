import queue from 'async/queue';
import { Statement } from 'better-sqlite3';
import Cron from 'croner';
import { mkdirSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import input from 'input';
import mimetics from 'mimetics';
import minimist from 'minimist';
import { Api, Logger, TelegramClient } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import { Dialog } from 'telegram/tl/custom/dialog';
import xbytes from 'xbytes';

import { Tonfig } from '@liesauer/tonfig';

import { Db } from './db';
import {
    array2dictionary, consoletable, DataDir, ellipsisLeft, ellipsisMiddle, md5, waitForever,
    waitTill
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

async function GetChannels<T = Api.PeerChannel>(ids: T[]): Promise<Api.TypeChat[]> {
    if (!ids.length) return [];

    // return client.invoke(new Api.channels.GetChannels({
    //     id: ids as Api.PeerChannel[],
    // })).then(v => v.chats);

    const _get = async <T = any>(ids: T[]) => {
        if (!ids.length) return [];

        return client.invoke(new Api.channels.GetChannels({
            id: ids as Api.PeerChannel[],
        })).then<Api.TypeChat[], Api.TypeChat[]>(v => v.chats, async _ => {
            if (ids.length < 2) return [];

            const mid   = Math.ceil(ids.length / 2);
            const part1 = ids.slice(0, mid);
            const part2 = ids.slice(mid);

            return [
                ...await GetChannels<T>(part1),
                ...await GetChannels<T>(part2),
            ];
        });
    };

    return await _get<T>(ids);
}

async function getChannelInfos(client: TelegramClient) {
    let dialogs: Dialog[] = [];

    for await (const dialog of client.iterDialogs()) {
        dialogs.push(dialog);
    }

    const ids = dialogs.map(v => v.dialog.peer).filter(v => v.className == "PeerChannel").map(v => v as Api.PeerChannel);

    const idsMap = array2dictionary(ids, (i, e) => {
        return { key: e.channelId.toString(), value: e };
    });

    const channels = await GetChannels(ids);

    const chats = channels.filter(v => v.className == "Channel").map(v => v as Api.Channel);

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

function shouldDownload(channelId: string, media: Api.TypeMessageMedia, type: "photo" | "video" | "audio" | "file") {
    let sizeNum: number;

    if (media instanceof Api.MessageMediaPhoto) {
        const photo = media.photo as Api.Photo;

        if (photo?.sizes?.length) {
            sizeNum = photo.sizes.map(v => {
                if (v instanceof Api.PhotoSize) {
                    return v.size;
                } else if (v instanceof Api.PhotoCachedSize) {
                    return v.bytes.length;
                } else if (v instanceof Api.PhotoStrippedSize) {
                    return v.bytes.length;
                } else if (v instanceof Api.PhotoSizeProgressive) {
                    return v.sizes.sort((a, b) => b - a)[0];
                } else if (v instanceof Api.PhotoPathSize) {
                    return v.bytes.length;
                }
            }).sort((a, b) => b - a)[0];
        }
    } else if (media instanceof Api.MessageMediaDocument) {
        const document = media.document as Api.Document;

        if (document?.size) {
            sizeNum = document.size.toJSNumber();
        }
    }

    // 暂时不识别的文件，宁愿多下载也不要缺
    if (sizeNum == null) return true;

    const limit1 = tonfig.get<string>(['filter', type, channelId], '');
    const limit2 = tonfig.get<string>(['filter', 'default', type], '');

    const limit = `${limit1 || limit2}`.split('-');

    // 格式：下限-上限，示例：10240-999999999，单位：字节
    if (limit.length == 2) {
        const num1 = Number(limit[0]);
        const num2 = Number(limit[1]);

        if (!isNaN(num1) && !isNaN(num2)) {
            const min = Math.min(num1, num2);
            const max = Math.max(num1, num2);

            if (sizeNum < min || sizeNum > max) {
                return false;
            }
        }
    }

    // if (sizeNum != null) {
    //     const tSize = xbytes(sizeNum);

    //     addLogHistory(tSize, tSize);
    // }

    return true;
}

async function downloadChannelMedia(client: TelegramClient, channelId: string, message: Api.MessageService, channelInfo: UnwrapAnnotatedDictionary<typeof waitQueue>, medias?: string[], groupMessage?: boolean, saveRawMessage?: boolean) {
    const photo = message.photo as Api.Photo;
    const video = message.video as Api.Document;
    const audio = message.audio as Api.Document;
    const file  = message.document && message.document.attributes.length == 1 && message.document.attributes[0].className == "DocumentAttributeFilename" ? message.file : null;

    /**
     * MessageService：修改频道头像、信息等等
     */
    const className = message.className as string;
    
    if (className != "Message") return;

    const messageId      = message.id ? message.id.toString() : '';
    const groupedId      = message.groupedId ? message.groupedId.toString() : '';
    const _replyId       = message.replyTo?.replyToTopId || message.replyTo?.replyToMsgId || message.replyToMsgId;
    let topicId          = (message.replyTo?.forumTopic && _replyId) ? _replyId.toString() : '';
    channelId            = channelId || '';
    let commentChannelId = '';

    if (channelInfo.forum && !topicId) {
        topicId = '1';
    }

    /**
     * 消息评论是需要在一个专门的频道承载的
     */
    if (message['comment']) {
        commentChannelId = (<Api.PeerChannel>message.peerId).channelId.toString();
    }

    let msg_uid = '';

    if (commentChannelId) {
        msg_uid = md5(`${channelId}_${topicId}_${commentChannelId}_${messageId}_${groupedId}`);
    } else {
        msg_uid = md5(`${channelId}_${topicId}_${messageId}_${groupedId}`);
    }

    let querySatement: Statement;
    let insertSatement: Statement;
    let updateSatement: Statement;

    if (saveRawMessage) {
        if (!downloadChannelMedia['_querySatement']) {
            downloadChannelMedia['_querySatement'] = database.prepare("SELECT id FROM message WHERE uniqueId = ?");
        }
        if (!downloadChannelMedia['_insertSatement']) {
            downloadChannelMedia['_insertSatement'] = database.prepare("INSERT INTO message (uniqueId, channelId, topicId, messageId, groupedId, text, rawMessage, fileName, savePath, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        }
        if (!downloadChannelMedia['_updateSatement']) {
            downloadChannelMedia['_updateSatement'] = database.prepare("UPDATE message SET fileName = ?, savePath = ? WHERE uniqueId = ?");
        }

        querySatement = downloadChannelMedia['_querySatement'];
        insertSatement = downloadChannelMedia['_insertSatement'];
        updateSatement = downloadChannelMedia['_updateSatement'];

        if (!querySatement.get(msg_uid)) {
            const rawMessage = JSON.stringify(message);

            insertSatement.run(msg_uid, channelId, topicId, messageId, groupedId, message.rawText || '', rawMessage, '', '', message.date || 0);
        }
    }

    let rawFileName = '';
    let fullFileName = '';
    let absSavePath = '';

    if (photo && (!medias || medias.includes('photo'))) {
        let media = message.media as Api.MessageMediaDocument;

        if (!shouldDownload(channelId, media, "photo")) {
            return;
        }

        let dir = DataDir() + '/' + channelId;

        let filename = `${messageId}`;
        let ext = '';
        let noExt = false;

        if (topicId) {
            dir += `/_${topicId}`;
        }

        if (groupedId) {
            if (groupMessage) {
                dir += `/${groupedId}`;
            } else {
                filename = `${groupedId}_` + filename;
            }
        }

        mkdirSync(dir, { recursive: true });

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                rawFileName = filenameAttr.fileName;
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        fullFileName = noExt ? filename : `${filename}.${ext || 'jpg'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        absSavePath = `${dir}/${fullFileName}`;

        await writeFile(absSavePath, buffer);
    }

    if (video && (!medias || medias.includes('video'))) {
        let media = message.media as Api.MessageMediaDocument;

        if (!shouldDownload(channelId, media, "video")) {
            return;
        }

        let dir = DataDir() + '/' + channelId;

        let filename = `${messageId}`;
        let ext = '';
        let noExt = false;

        if (topicId) {
            dir += `/_${topicId}`;
        }

        if (groupedId) {
            if (groupMessage) {
                dir += `/${groupedId}`;
            } else {
                filename = `${groupedId}_` + filename;
            }
        }

        mkdirSync(dir, { recursive: true });

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                rawFileName = filenameAttr.fileName;
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        fullFileName = noExt ? filename : `${filename}.${ext || 'mp4'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        absSavePath = `${dir}/${fullFileName}`;

        await writeFile(absSavePath, buffer);
    }

    if (audio && (!medias || medias.includes('audio'))) {
        let media = message.media as Api.MessageMediaDocument;

        if (!shouldDownload(channelId, media, "audio")) {
            return;
        }

        let dir = DataDir() + '/' + channelId;

        let filename = `${messageId}`;
        let ext = '';
        let noExt = false;

        if (topicId) {
            dir += `/_${topicId}`;
        }

        if (groupedId) {
            if (groupMessage) {
                dir += `/${groupedId}`;
            } else {
                filename = `${groupedId}_` + filename;
            }
        }

        mkdirSync(dir, { recursive: true });

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                rawFileName = filenameAttr.fileName;
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        fullFileName = noExt ? filename : `${filename}.${ext || 'mp3'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        absSavePath = `${dir}/${fullFileName}`;

        await writeFile(absSavePath, buffer);
    }

    if (file && (!medias || medias.includes('file'))) {
        let media = message.media as Api.MessageMediaDocument;

        if (!shouldDownload(channelId, media, "file")) {
            return;
        }

        let dir = DataDir() + '/' + channelId;

        let filename = `${messageId}`;
        let ext = '';
        let noExt = false;

        if (topicId) {
            dir += `/_${topicId}`;
        }

        if (groupedId) {
            if (groupMessage) {
                dir += `/${groupedId}`;
            } else {
                filename = `${groupedId}_` + filename;
            }
        }

        mkdirSync(dir, { recursive: true });

        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        if (media?.document) {
            const document = media.document as Api.Document;

            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;

            if (filenameAttr && filenameAttr.fileName) {
                rawFileName = filenameAttr.fileName;
                filename += `_${filenameAttr.fileName}`;
                noExt = true;
            }
        }

        fullFileName = noExt ? filename : `${filename}.${ext || 'dat'}`;

        channelInfo.fileName = fullFileName;

        const buffer = await client.downloadMedia(message.media, {
            progressCallback: (bytes, total) => {
                channelInfo.downloadedBytes = bytes;
                channelInfo.totalBytes = total;
            },
        });

        absSavePath = `${dir}/${fullFileName}`;

        await writeFile(absSavePath, buffer);
    }

    if (saveRawMessage && (rawFileName || absSavePath)) {
        const savePath = absSavePath.replace(DataDir() + '/', '');

        updateSatement.run(rawFileName, savePath, msg_uid);
    }
}

const listChannels = !!argv['list'];
let channelTable: {
    ID: string,
    频道名: string,
}[] = [];
let maxLogHistory = 10;
let logHistory: string[] = [];

let logger: Logger = new MyLogger();
let client: TelegramClient;
let tonfig: Tonfig;

let uiTimer: Cron;
let mainTimer: Cron;
let mediaSpiderTimer: Cron;

let database: Db;

let channelInfos: Awaited<ReturnType<typeof getChannelInfos>>;

const waitQueue: AnnotatedDictionary<{
    channelId: string,
    channelTitle: string,
    forum: boolean,
    topics: {
        id: number,
        title: string,
    }[],
    downloading: boolean,
    fileName: string,
    downloadedBytes: bigInt.BigInteger,
    totalBytes: bigInt.BigInteger,
    messages: Api.MessageService[],
    medias: string[],
    lastDownloadTime: number,
}, "channelId"> = {};

let execQueue;

async function mediaSpider() {
    await client.connect();

    const allowChannels = tonfig.get<string[]>('spider.channels', []);

    for (const channel of channelInfos) {
        const channelId = channel.id.toString();
        const channelTitle = channel.title || '';

        if (!allowChannels.includes(channelId)) continue;

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
                forum: channel.forum,
                topics: channel.topics || [],
                downloading: false,
                fileName: '',
                downloadedBytes: null,
                totalBytes: null,
                messages: [],
                medias: mediasArr,
                lastDownloadTime: 0,
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

        const lastId = tonfig.get(['spider', 'lastIds', channelId], 0);

        const messages = await getChannelMessages(client, channelId, lastId, undefined, -1);

        if (!lastId && !messages.messages.length) {
            const topId = messages.messages.length ? messages.messages[0].id : messages.lastId;
            tonfig.set(['spider', 'lastIds', channelId], topId);
            await tonfig.save();
        }

        for (const message of messages.messages) {
            waitQueue[channelId].messages.push(message);

            execQueue.push();

            // 消息评论
            if (message.replies?.replies && message.replies?.channelId) {
                const result = await client.invoke(
                    new Api.messages.GetReplies({
                    peer: message.peerId,
                    msgId: message.id,
                    })
                ).catch(_ => null) as Api.messages.ChannelMessages;

                if (result && result.messages?.length) {
                    const comments = result.messages.reverse();

                    for (const comment of comments) {
                        waitQueue[channelId].messages.push(comment as Api.MessageService);

                        comment['comment'] = true;

                        execQueue.push();
                    }
                }
            }
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
                forum: false,
                topics: [],
                downloading: true,
                fileName: '',
                downloadedBytes: null,
                totalBytes: null,
                messages: null,
                medias: null,
                lastDownloadTime: 0,
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

async function loadConfig() {
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
            lastIds: {},
            medias: {
                _: "photo,video,audio,file",
            },
            groupMessage: false,
            saveRawMessage: false,
        },

        filter: {
            default: {
                photo: "0-10737418240",
                video: "0-10737418240",
                audio: "0-10737418240",
                file:  "0-10737418240",
            },
            photo: {
                _: "0-10737418240",
            },
            video: {
                _: "0-10737418240",
            },
            audio: {
                _: "0-10737418240",
            },
            file: {
                _: "0-10737418240",
            },
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
}

function getAccountConfig() {
    const apiId = tonfig.get<number>("account.apiId");
    const apiHash = tonfig.get<string>("account.apiHash");
    const account = tonfig.get<string>("account.account");
    const session = tonfig.get<string>("account.session", "");

    return { apiId, apiHash, account, session };
}

function getProxyConfig() {
    const ip = tonfig.get<string>("proxy.ip", "");
    const port = tonfig.get<number>("proxy.port", 0);
    const username = tonfig.get<string>("proxy.username", "");
    const password = tonfig.get<string>("proxy.password", "");
    const MTProxy = tonfig.get<boolean>("proxy.MTProxy", false);
    const secret = tonfig.get<string>("proxy.secret", "");
    const socksType = tonfig.get<5 | 4>("proxy.socksType", 5);
    const timeout = tonfig.get<number>("proxy.timeout", 2);

    return { ip, port, username, password, MTProxy, secret, socksType, timeout };
}

async function checkConfig() {
    await loadConfig();

    const { apiId, apiHash, account } = getAccountConfig();

    if (!apiId || !apiHash || !account) {
        logger.info('请编辑 data/config.toml 进行账号配置，软件将开始检测并自动重载');
        logger.info('https://github.com/liesauer/TeleMediaSpider?tab=readme-ov-file#1-%E9%A6%96%E6%AC%A1%E8%BF%90%E8%A1%8C');

        const timer = setInterval(() => {
            loadConfig();
        }, 3000);

        await waitTill(() => {
            const { apiId, apiHash, account } = getAccountConfig();

            if (apiId && apiHash && account) {
                clearInterval(timer);
                logger.info('读取到账号配置，正在重载');

                return true;
            }

            return false;
        }, 1000);
    }
}

async function checkChannel() {
    await loadConfig();

    const allowChannels = tonfig.get<string[]>('spider.channels', []);

    if (!allowChannels?.length) {
        logger.info('请编辑 data/config.toml 进行频道配置，软件将开始检测并自动重载');
        logger.info('https://github.com/liesauer/TeleMediaSpider?tab=readme-ov-file#2-%E9%85%8D%E7%BD%AE%E9%A2%91%E9%81%93%E5%88%97%E8%A1%A8');

        const timer = setInterval(() => {
            loadConfig();
        }, 3000);

        await waitTill(() => {
            const allowChannels = tonfig.get<string[]>('spider.channels', []);

            if (allowChannels?.length) {
                clearInterval(timer);
                logger.info('读取到频道配置，正在重载');

                return true;
            }

            return false;
        }, 1000);
    }
}

async function main() {
    logger = new MyLogger();

    mkdirSync(DataDir(), { recursive: true });

    await checkConfig();

    const saveRawMessage = tonfig.get<boolean>("spider.saveRawMessage", false);

    if (saveRawMessage) {
        database = Db.db();
    }

    let { apiId, apiHash, account, session } = getAccountConfig();

    if (!session) {
        logger.info('请按提示进行登录');
    }

    const proxy = getProxyConfig();

    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
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

    if (!session) {
        session = <string><unknown>client.session.save();
        tonfig.set("account.session", session);

        await tonfig.save();

        if (session) {
            logger.info('登录成功，登录状态会保持');
        } else {
            logger.info('登录失败');

            await waitForever();
        }
    }

    channelInfos = await getChannelInfos(client);

    channelTable = channelInfos.map(channel => {
        return {
            "ID": channel.id.toString(),
            "频道名": channel.title,
        };
    });

    {
        const maxIdLength = Math.max(...channelTable.map(v => v.ID.length));

        const logFile = DataDir() + '/channels.txt';

        const logContent = channelTable.map(v => {
            const id = v.ID.padStart(maxIdLength, ' ');
            const title = v.频道名;

            return `${id}    ${title}`;
        }).join("\n");

        writeFileSync(logFile, logContent, {
            encoding: 'utf-8',
        });
    }

    if (saveRawMessage) {
        database.emptyTable('channel');

        const satement = database.prepare<string[]>("INSERT INTO channel (id, pid, title) VALUES (?, ?, ?)");

        for (const channelInfo of channelInfos) {
            const id = channelInfo.id.toString();
            const title = channelInfo.title || '';

            satement.run(id, '', title);

            for (const topic of channelInfo.topics) {
                const tid = topic.id.toString();
                const title = topic.title || '';

                satement.run(tid, id, title);
            }
        }
    }

    if (!listChannels) {
        await checkChannel();
    }

    if (uiTimer) {
        uiTimer.resume();
    }

    if (listChannels) {
        // 等待render输出channelTable
        // 后面代码不再执行
        await waitForever();
    }

    const concurrency = tonfig.get<number>("spider.concurrency", 5);

    const groupMessage = tonfig.get<boolean>("spider.groupMessage", false);

    execQueue = execQueue || queue(async function(task, callback) {
        let channelInfo: UnwrapAnnotatedDictionary<typeof waitQueue>;

        await waitTill(() => {
            channelInfo = Object.values(waitQueue).filter(v => !v.downloading && v.messages.length).sort((a, b) => {
                return a.lastDownloadTime - b.lastDownloadTime;
            })[0];

            return !!channelInfo;
        }, 100);

        channelInfo.downloading = true;

        const channelId = channelInfo.channelId;
        const message = channelInfo.messages[0];
        const mediasArr = channelInfo.medias;

        // channelInfo.messages.shift();

        // // 下载成功，保存当前频道位置
        // tonfig.set(['spider', 'lastIds', channelId], message.id);
        // await tonfig.save();

        // channelInfo.downloading = false;
        // channelInfo.lastDownloadTime = Date.now();

        // callback();

        await downloadChannelMedia(client, channelId, message, channelInfo, mediasArr, groupMessage, saveRawMessage).then(async () => {
            channelInfo.messages.shift();

            if (!message['comment']) {
                // 下载成功，保存当前频道位置
                tonfig.set(['spider', 'lastIds', channelId], message.id);
                await tonfig.save();
            }
        }, () => {
            // 下载失败，啥也不用管，后面根据队列自动重试
        }).finally(() => {
            channelInfo.downloading = false;
            channelInfo.lastDownloadTime = Date.now();

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
