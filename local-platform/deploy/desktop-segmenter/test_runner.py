"""本文件验证离线抠图 Runner 的请求门禁、预处理和蒙版归一化。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

import runner


class SegmenterRunnerTests(unittest.TestCase):
    """不下载大模型即可执行的确定性单元测试。"""

    def test_request_requires_one_to_two_hundred_items(self) -> None:
        """空批次和超量批次必须在加载模型前被拒绝。"""
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / "request.json"
            request.write_text(json.dumps({"items": []}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "1–200"):
                runner.load_request(request)
            request.write_text(
                json.dumps({"items": [{} for _ in range(201)]}), encoding="utf-8"
            )
            with self.assertRaisesRegex(ValueError, "1–200"):
                runner.load_request(request)

    def test_prepare_image_uses_finite_nchw_float_input(self) -> None:
        """任意输入尺寸都必须转换成 U2Net 固定的有限浮点张量。"""
        image = Image.new("RGBA", (64, 48), (120, 80, 40, 128))
        prepared = runner.prepare_image(image)
        self.assertEqual(prepared.shape, (1, 3, 320, 320))
        self.assertEqual(prepared.dtype, np.float32)
        self.assertTrue(np.isfinite(prepared).all())

    def test_create_mask_restores_requested_size_and_rejects_constant_output(self) -> None:
        """有效预测恢复原尺寸，常量或非有限输出不能伪造成透明蒙版。"""
        prediction = np.linspace(0.0, 1.0, 320 * 320, dtype=np.float32).reshape(
            1, 1, 320, 320
        )
        mask = runner.create_mask(prediction, (80, 120))
        self.assertEqual(mask.mode, "L")
        self.assertEqual(mask.size, (80, 120))
        self.assertLess(mask.getextrema()[0], mask.getextrema()[1])
        with self.assertRaisesRegex(ValueError, "无效蒙版"):
            runner.create_mask(np.ones((1, 1, 320, 320), dtype=np.float32), (32, 32))


if __name__ == "__main__":
    unittest.main()
