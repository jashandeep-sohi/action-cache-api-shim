import fastify from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import qs from "qs";
import { internalCacheTwirpClient } from "../node_modules/@actions/cache/lib/internal/shared/cacheTwirpClient.js";
import { BlobClient } from "@azure/storage-blob";
import { randomBytes } from "crypto";
import { parse as parseContentRange } from "content-range";
import { Mutex } from "async-mutex";
import { createHash } from "crypto";

export async function setupServer() {
  const svc = fastify({
    logger: true,
    querystringParser: (s) => qs.parse(s, { comma: true })
  }).withTypeProvider<TypeBoxTypeProvider>();

  svc.addContentTypeParser(
    "application/octet-stream",
    function (req, payload, done) {
      done(null);
    }
  );

  type CacheId = number;
  type Block = {
    id: string;
    start: number;
    end: number;
    size: number;
  };
  type ReservedKey = {
    key: string;
    version: string;
    uploadUrl: string;
    blocks: Block[];
  };

  type State = {
    mutex: Mutex;
    cacheIdCounter: CacheId;
    reserved: Record<CacheId, ReservedKey>;
  };

  const state: State = {
    mutex: new Mutex(),
    cacheIdCounter: 1,
    reserved: {}
  };

  const saltVersion = (v: string) =>
    createHash("sha256").update(`v2|${v}`).digest("hex");

  const routePrefix = "/_apis/artifactcache";

  svc.get(
    `${routePrefix}/cache`,
    {
      schema: {
        querystring: Type.Object({
          keys: Type.Array(Type.String(), { minItems: 1 }),
          version: Type.String()
        }),
        response: {
          "200": Type.Object({
            cacheKey: Type.String(),
            scope: Type.String(),
            archiveLocation: Type.String()
          }),
          "404": Type.Object({
            message: Type.String()
          })
        }
      }
    },
    async (req, resp) => {
      const [primaryKey, ...restoreKeys] = req.query.keys;

      const cacheClient = internalCacheTwirpClient();

      const cacheEntryResp = await cacheClient.GetCacheEntryDownloadURL({
        key: primaryKey,
        restoreKeys: restoreKeys,
        version: saltVersion(req.query.version)
      });

      if (!cacheEntryResp.ok) {
        return {
          cacheKey: "",
          scope: "",
          archiveLocation: ""
        };
      }

      return {
        cacheKey: cacheEntryResp.matchedKey,
        scope: "", // not sure what this is supposed to be
        archiveLocation: cacheEntryResp.signedDownloadUrl
      };
    }
  );

  svc.post(
    `${routePrefix}/caches`,
    {
      schema: {
        body: Type.Object({
          key: Type.String(),
          version: Type.String()
        }),
        response: {
          200: Type.Object({
            cacheID: Type.Integer()
          }),
          404: Type.Object({})
        }
      }
    },
    async (req, resp) => {
      const cacheClient = internalCacheTwirpClient();

      const createResp = await cacheClient.CreateCacheEntry({
        key: req.body.key,
        version: saltVersion(req.body.version)
      });

      if (!createResp.ok) {
        return resp.code(400).send({});
      }

      const cacheId = await state.mutex.runExclusive(async () => {
        return state.cacheIdCounter++;
      });

      state.reserved[cacheId] = {
        key: req.body.key,
        version: req.body.version,
        uploadUrl: createResp.signedUploadUrl,
        blocks: []
      };

      return {
        cacheID: cacheId
      };
    }
  );

  svc.patch(
    `${routePrefix}/caches/:cacheID`,
    {
      schema: {
        headers: Type.Object({
          "content-range": Type.String(),
          "content-type": Type.Literal("application/octet-stream")
        }),
        params: Type.Object({
          cacheID: Type.Integer()
        }),
        response: {
          200: Type.Null(),
          404: Type.Null(),
          500: Type.Object({
            message: Type.String()
          })
        }
      }
    },
    async (req, resp) => {
      const cacheID = req.params.cacheID;
      if (!(cacheID in state.reserved)) {
        return resp.code(404).send();
      }

      const contentRange = parseContentRange(req.headers["content-range"]);
      if (contentRange === null) {
        return resp.code(500).send({ message: "content range is null" });
      }
      const { start, end } = contentRange;
      if (start == null || end == null) {
        return resp
          .code(500)
          .send({ message: "content range components are null" });
      }

      const size = end - start + 1;

      const { uploadUrl, blocks } = state.reserved[cacheID];

      const blobClient = new BlobClient(uploadUrl);
      const blockClient = blobClient.getBlockBlobClient();

      const blockId = randomBytes(64).toString("base64");

      await blockClient.stageBlock(blockId, req.raw, size);

      blocks.push({
        id: blockId,
        start: start,
        end: end,
        size: size
      });
    }
  );

  svc.post(
    `${routePrefix}/caches/:cacheID`,
    {
      schema: {
        params: Type.Object({
          cacheID: Type.Integer()
        }),
        body: Type.Object({
          size: Type.Integer()
        }),
        response: {
          200: Type.Null(),
          404: Type.Object({
            message: Type.String()
          }),
          400: Type.Object({
            message: Type.String()
          })
        }
      }
    },
    async (req, resp) => {
      const cacheID = req.params.cacheID;
      if (!(cacheID in state.reserved)) {
        return resp.code(404).send({ message: "cache id not found" });
      }
      const { uploadUrl, blocks, key, version } = state.reserved[cacheID];

      const totalSize = blocks.reduce((sum, b) => sum + b.size, 0);

      if (totalSize != req.body.size) {
        return resp.code(400).send({
          message: `total size incorrect: totalSize=${totalSize}, size=${req.body.size}`
        });
      }

      const blockIds = blocks
        .sort((a, b) => a.start - b.start)
        .map((x) => x.id);

      const blobClient = new BlobClient(uploadUrl);
      const blockClient = blobClient.getBlockBlobClient();

      await blockClient.commitBlockList(blockIds);

      const cacheClient = internalCacheTwirpClient();

      const finalizeResp = await cacheClient.FinalizeCacheEntryUpload({
        key,
        version: saltVersion(version),
        sizeBytes: `${totalSize}`
      });

      if (!finalizeResp.ok) {
        return resp.code(400).send({ message: "v2 API did not like it" });
      }

      delete state.reserved[cacheID];
    }
  );

  svc.listen({ host: "127.0.0.1", port: 0 }, (err, address) => {
    if (err) {
      svc.log.error(err);
      process.exit(1);
    }
    process.send?.({ kind: "ready", address: address });
  });
}
