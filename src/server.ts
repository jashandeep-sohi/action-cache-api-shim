import fastify from "fastify";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { Type } from "@sinclair/typebox";
import qs from "qs";
import { internalCacheTwirpClient } from "../node_modules/@actions/cache/lib/internal/shared/cacheTwirpClient.js";
import { BlobClient } from "@azure/storage-blob";
import { randomBytes } from "crypto";
import { parse as parseContentRange } from "content-range";

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
    cacheIdCounter: CacheId;
    reserved: Record<CacheId, ReservedKey>;
  };

  const state: State = {
    cacheIdCounter: 0,
    reserved: {}
  };

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
          404: Type.Object({})
        }
      }
    },
    async (req, resp) => {
      const [primaryKey, ...restoreKeys] = req.query.keys;

      const cacheClient = internalCacheTwirpClient();

      const cacheEntryResp = await cacheClient.GetCacheEntryDownloadURL({
        key: primaryKey,
        restoreKeys,
        version: req.query.version
      });

      if (!cacheEntryResp.ok) {
        return resp.code(404).send({});
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
        version: req.body.version
      });

      if (!createResp.ok) {
        return resp.code(400).send({});
      }

      const cacheId = state.cacheIdCounter++;
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
          500: Type.Null()
        }
      }
    },
    async (req, resp) => {
      if (!(req.params.cacheID in state.reserved)) {
        return resp.code(404).send();
      }

      const contentRange = parseContentRange(req.headers["content-range"]);
      if (contentRange === null) {
        return resp.code(500).send();
      }
      const { start, end, size } = contentRange;
      if (start == null || end == null || size == null) {
        return resp.code(500).send();
      }

      const { uploadUrl, blocks } = state.reserved[req.params.cacheID];

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
          404: Type.Null(),
          400: Type.Null()
        }
      }
    },
    async (req, resp) => {
      if (!(req.params.cacheID in state.reserved)) {
        return resp.code(404).send();
      }
      const { uploadUrl, blocks, key, version } =
        state.reserved[req.params.cacheID];

      const totalSize = blocks.reduce((sum, b) => sum + b.size, 0);

      if (totalSize != req.body.size) {
        return resp.code(400).send();
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
        version,
        sizeBytes: `${totalSize}`
      });

      if (!finalizeResp.ok) {
        return resp.code(400).send();
      }

      delete state.reserved[req.params.cacheID];
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
