-- CreateEnum
CREATE TYPE "Status" AS ENUM ('PENDING', 'DOWNLOADING', 'PAUSED', 'COMPLETED', 'ERROR', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "ChunkStatus" AS ENUM ('PENDING', 'ACTIVE', 'DONE', 'ERROR');

-- CreateTable
CREATE TABLE "Download" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "directory" TEXT NOT NULL,
    "totalSize" BIGINT,
    "downloadedSize" BIGINT NOT NULL DEFAULT 0,
    "chunkCount" INTEGER NOT NULL DEFAULT 1,
    "status" "Status" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Download_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "downloadId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "startByte" BIGINT NOT NULL,
    "endByte" BIGINT,
    "downloadedBytes" BIGINT NOT NULL DEFAULT 0,
    "status" "ChunkStatus" NOT NULL DEFAULT 'PENDING',

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Download_status_idx" ON "Download"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_downloadId_index_key" ON "Chunk"("downloadId", "index");

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_downloadId_fkey" FOREIGN KEY ("downloadId") REFERENCES "Download"("id") ON DELETE CASCADE ON UPDATE CASCADE;
