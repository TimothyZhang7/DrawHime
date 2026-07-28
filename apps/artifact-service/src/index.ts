/** 本文件启动产物服务控制面，上传与下载签名接口将在鉴权完成后开放。 */
import { createDatabaseCheck, createObjectStorageCheck, startService } from "@drawhime/service-runtime";

startService({
  name: "artifact-service",
  port: Number(process.env.LOCAL_ARTIFACT_SERVICE_PORT || 7113),
  checks: [createDatabaseCheck(), createObjectStorageCheck()],
});
