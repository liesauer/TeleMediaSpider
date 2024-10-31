PRAGMA foreign_keys = false;

-- ----------------------------
-- Table structure for message
-- ----------------------------
DROP TABLE IF EXISTS "message";
CREATE TABLE "message" (
  "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "uniqueId"   TEXT NOT NULL,
  "channelId"  TEXT NOT NULL,
  "topicId"    TEXT NOT NULL,
  "messageId"  TEXT NOT NULL,
  "groupedId"  TEXT NOT NULL,
  "text"       TEXT NOT NULL,
  "rawMessage" TEXT NOT NULL,
  "fileName"   TEXT NOT NULL,
  "savePath"   TEXT NOT NULL,
  "date"       DATE NOT NULL,
  CONSTRAINT "id" UNIQUE ("id" ASC),
  CONSTRAINT "uniqueId" UNIQUE ("uniqueId" ASC)
);

-- ----------------------------
-- Records of message
-- ----------------------------

-- ----------------------------
-- Auto increment value for message
-- ----------------------------
UPDATE "sqlite_sequence" SET seq = 1 WHERE name = 'message';

PRAGMA foreign_keys = true;
