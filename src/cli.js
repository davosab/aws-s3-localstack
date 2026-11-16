#!/usr/bin/env node
// Document archive on S3 (LocalStack). Usage: node src/cli.js <command> [args]
import { createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  CreateBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  PutBucketVersioningCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { s3, BUCKET } from "./config.js";

const CONTENT_TYPES = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv",
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

function need(value, usage) {
  if (!value) {
    console.error(`Usage: node src/cli.js ${usage}`);
    process.exit(1);
  }
  return value;
}

const commands = {
  // CREATE: a bucket is the top-level container for objects.
  async "create-bucket"() {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket created: ${BUCKET}`);
  },

  async buckets() {
    const { Buckets = [] } = await s3.send(new ListBucketsCommand({}));
    if (Buckets.length === 0) return console.log("(no buckets)");
    for (const b of Buckets) console.log(`${b.CreationDate.toISOString()}  ${b.Name}`);
  },

  // INSERT: upload a file with a content type and custom metadata.
  async upload(file, key) {
    need(file, "upload <file> [key]");
    key ??= basename(file);
    const size = statSync(file).size;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
        Metadata: { "original-name": basename(file), "uploaded-by": "cli" },
      }),
    );
    console.log(`Uploaded ${file} -> s3://${BUCKET}/${key} (${kb(size)})`);
  },

  // READ: list objects; a "folder" is just a key prefix such as documents/2026/.
  async list(prefix = "") {
    let token;
    let count = 0;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
      );
      for (const o of page.Contents ?? []) {
        console.log(`${o.LastModified.toISOString()}  ${kb(o.Size).padStart(10)}  ${o.Key}`);
        count++;
      }
      token = page.NextContinuationToken;
    } while (token);
    console.log(`${count} object(s) under "${prefix || "/"}"`);
  },

  // READ: metadata only, without downloading the body.
  async info(key) {
    need(key, "info <key>");
    const h = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log({
      key,
      size: kb(h.ContentLength),
      contentType: h.ContentType,
      lastModified: h.LastModified.toISOString(),
      etag: h.ETag,
      versionId: h.VersionId ?? "(versioning off)",
      metadata: h.Metadata,
    });
  },

  // READ: download the object body to downloads/<key>.
  async download(key, dest) {
    need(key, "download <key> [destination]");
    dest ??= join("downloads", key);
    mkdirSync(dirname(dest), { recursive: true });
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    await pipeline(obj.Body, createWriteStream(dest));
    console.log(`Downloaded s3://${BUCKET}/${key} -> ${dest}`);
  },

  // SHARE: temporary link that works without credentials until it expires.
  async presign(key, seconds = "300") {
    need(key, "presign <key> [seconds]");
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
      expiresIn: Number(seconds),
    });
    console.log(`Valid for ${seconds}s:\n${url}`);
  },

  async "enable-versioning"() {
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: BUCKET,
        VersioningConfiguration: { Status: "Enabled" },
      }),
    );
    console.log(`Versioning enabled on ${BUCKET}`);
  },

  async versions(key) {
    need(key, "versions <key>");
    const res = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET, Prefix: key }));
    const rows = [
      ...(res.Versions ?? []).map((v) => ({ ...v, kind: "version" })),
      ...(res.DeleteMarkers ?? []).map((v) => ({ ...v, kind: "delete-marker" })),
    ].filter((v) => v.Key === key);
    if (rows.length === 0) return console.log(`No versions found for ${key}`);
    // S3 returns versions newest first; put the current one (maybe a delete marker) on top.
    rows.sort((a, b) => b.IsLatest - a.IsLatest);
    for (const v of rows) {
      const size = v.kind === "version" ? kb(v.Size) : "-";
      console.log(
        `${v.IsLatest ? "* latest" : "        "}  ${v.VersionId}  ${size.padStart(10)}  ${v.LastModified.toISOString()}  ${v.kind}`,
      );
    }
  },

  // Restore = read an old version and write it again under the same key,
  // so it becomes the newest version. The history stays intact.
  async restore(key, versionId) {
    need(key && versionId, "restore <key> <versionId>");
    const old = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, VersionId: versionId }));
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: Buffer.from(await old.Body.transformToByteArray()),
        ContentType: old.ContentType,
        Metadata: { ...old.Metadata, "restored-from": versionId },
      }),
    );
    console.log(`Restored ${key} from version ${versionId} (new version: ${res.VersionId})`);
  },

  // DELETE: with versioning on, this only adds a delete marker; old versions remain.
  async delete(key) {
    need(key, "delete <key>");
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log(`Deleted s3://${BUCKET}/${key}`);
  },

  // DELETE: S3 refuses to delete a non-empty bucket, so remove every object version first.
  async "delete-bucket"() {
    let removed = 0;
    let more = true;
    while (more) {
      const res = await s3.send(new ListObjectVersionsCommand({ Bucket: BUCKET }));
      const objects = [...(res.Versions ?? []), ...(res.DeleteMarkers ?? [])].map((v) => ({
        Key: v.Key,
        VersionId: v.VersionId,
      }));
      if (objects.length > 0) {
        await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } }));
        removed += objects.length;
      }
      more = res.IsTruncated;
    }
    await s3.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    console.log(`Removed ${removed} object version(s) and deleted bucket ${BUCKET}`);
  },

  help() {
    console.log(`Document archive on S3 (bucket: ${BUCKET})

Usage: node src/cli.js <command> [args]

  create-bucket                  create the bucket
  buckets                        list all buckets
  upload <file> [key]            upload a file (key defaults to the file name)
  list [prefix]                  list objects, optionally under a prefix
  info <key>                     show metadata of an object
  download <key> [dest]          download to downloads/<key>
  presign <key> [seconds]        temporary download link (default 300 s)
  enable-versioning              keep every version of every object
  versions <key>                 list the versions of an object
  restore <key> <versionId>      make an old version the current one
  delete <key>                   delete an object
  delete-bucket                  delete all objects and the bucket

Set BUCKET=<name> to use a different bucket.`);
  },
};

const [name = "help", ...args] = process.argv.slice(2);
const command = commands[name];
if (!command) {
  console.error(`Unknown command "${name}".\n`);
  commands.help();
  process.exit(1);
}

try {
  await command(...args);
} catch (err) {
  const code = err.code ?? err.cause?.code;
  if (["ECONNREFUSED", "ECONNRESET"].includes(code) || /socket hang up/i.test(err.message)) {
    console.error("Cannot reach LocalStack on http://localhost:4566. Is `docker compose up -d` running?");
  } else if (err.name === "NotFound" || err.name === "NoSuchKey") {
    console.error(`Object not found in bucket ${BUCKET}: ${args[0]}`);
  } else if (err.name === "NoSuchBucket") {
    console.error(`Bucket ${BUCKET} does not exist. Run: node src/cli.js create-bucket`);
  } else {
    console.error(`${err.name}: ${err.message}`);
  }
  process.exit(1);
}
