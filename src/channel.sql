PRAGMA foreign_keys = false;

-- ----------------------------
-- Table structure for channel
-- ----------------------------
DROP TABLE IF EXISTS "channel";
CREATE TABLE "channel" (
  "id"    TEXT NOT NULL,
  "pid"   TEXT NOT NULL,
  "title" TEXT NOT NULL
);

-- ----------------------------
-- Records of channel
-- ----------------------------

PRAGMA foreign_keys = true;
