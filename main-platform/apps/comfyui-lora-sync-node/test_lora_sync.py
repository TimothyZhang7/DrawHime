"""本文件验证 ComfyUI LoRA 节点的断点追加、偏移冲突、完成安装和旧接口兼容。"""

import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer


class LoraSyncNodeTest(unittest.IsolatedAsyncioTestCase):
    """使用临时 LoRA 目录运行真实 aiohttp 路由，不接触本机模型文件。"""

    async def asyncSetUp(self) -> None:
        """注入最小 ComfyUI 模块并启动节点路由。"""
        self.temporary_directory = tempfile.TemporaryDirectory()
        lora_directory = self.temporary_directory.name
        folder_paths = types.ModuleType("folder_paths")
        folder_paths.get_folder_paths = lambda _name: [lora_directory]
        folder_paths.filename_list_cache = {}
        folder_paths.cache_helper = types.SimpleNamespace(clear=lambda: None)
        routes = web.RouteTableDef()
        server = types.ModuleType("server")
        server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=routes))
        sys.modules["folder_paths"] = folder_paths
        sys.modules["server"] = server
        module_path = Path(__file__).with_name("__init__.py")
        specification = importlib.util.spec_from_file_location("aiimage_lora_sync_test_module", module_path)
        if specification is None or specification.loader is None:
            raise RuntimeError("LoRA 同步节点测试模块加载失败")
        self.module = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(self.module)
        os.environ["AIIMAGE_LORA_SYNC_TOKEN"] = "test-token"
        application = web.Application()
        application.add_routes(routes)
        self.client = TestClient(TestServer(application))
        await self.client.start_server()

    async def asyncTearDown(self) -> None:
        """关闭测试服务器并清理临时目录和服务 token。"""
        await self.client.close()
        self.temporary_directory.cleanup()
        os.environ.pop("AIIMAGE_LORA_SYNC_TOKEN", None)

    async def test_resumable_upload_and_legacy_put(self) -> None:
        """断点接口按偏移续传并完成原子安装，旧完整 PUT 仍可使用。"""
        content = self._safetensors_bytes("first")
        sha256 = hashlib.sha256(content).hexdigest()
        file_name = f"aiimage_lora_{sha256}.safetensors"
        upload_path = f"/aiimage/loras/{file_name}/upload"
        headers = {
            "x-service-token": "test-token",
            "x-aiimage-sha256": sha256,
            "x-aiimage-total-bytes": str(len(content)),
        }
        first_size = len(content) // 2
        first = await self.client.put(upload_path, headers={**headers, "x-aiimage-offset": "0"}, data=content[:first_size])
        self.assertEqual(first.status, 200)

        conflict = await self.client.put(upload_path, headers={**headers, "x-aiimage-offset": "0"}, data=content[first_size:])
        self.assertEqual(conflict.status, 409)
        conflict_body = await conflict.json()
        self.assertEqual(conflict_body["offset"], first_size)

        status = await self.client.get(upload_path, headers=headers)
        self.assertEqual((await status.json())["data"]["offset"], first_size)
        second = await self.client.put(upload_path, headers={**headers, "x-aiimage-offset": str(first_size)}, data=content[first_size:])
        self.assertEqual(second.status, 200)
        completed = await self.client.post(upload_path, headers=headers)
        self.assertEqual(completed.status, 200)
        installed = await self.client.get(f"/aiimage/loras/{file_name}", headers={"x-service-token": "test-token"})
        installed_body = await installed.json()
        self.assertEqual(installed_body["sha256"], sha256)
        self.assertEqual(installed_body["sizeBytes"], len(content))

        legacy_content = self._safetensors_bytes("legacy")
        legacy_sha256 = hashlib.sha256(legacy_content).hexdigest()
        legacy_name = f"aiimage_lora_{legacy_sha256}.safetensors"
        legacy = await self.client.put(
            f"/aiimage/loras/{legacy_name}",
            headers={"x-service-token": "test-token", "x-aiimage-sha256": legacy_sha256},
            data=legacy_content,
        )
        self.assertEqual(legacy.status, 200)
        self.assertEqual((await legacy.json())["sha256"], legacy_sha256)

    @staticmethod
    def _safetensors_bytes(name: str) -> bytes:
        """构造包含一个真实张量目录的最小 safetensors 测试文件。"""
        header = json.dumps({name: {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}, separators=(",", ":")).encode("utf-8")
        return len(header).to_bytes(8, "little") + header + b"\x00\x00\x00\x00"


if __name__ == "__main__":
    unittest.main()
