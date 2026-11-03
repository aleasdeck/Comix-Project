"""Минимальный клиент ComfyUI API (без внешних зависимостей).

Воркфлоу хранятся в workflows/*.json в формате API (в ComfyUI:
Settings -> Enable Dev mode, потом Workflow -> Export (API)).
В JSON вместо значений ставятся плейсхолдеры вида "{{SEED}}":
строка, целиком равная плейсхолдеру, заменяется значением нужного типа
(число остаётся числом), а внутри длинных строк делается текстовая подстановка.
"""

from __future__ import annotations

import io
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from PIL import Image


def fill_template(node, values: dict):
    if isinstance(node, dict):
        return {k: fill_template(v, values) for k, v in node.items()}
    if isinstance(node, list):
        return [fill_template(v, values) for v in node]
    if isinstance(node, str):
        if node.startswith("{{") and node.endswith("}}") and node[2:-2] in values:
            return values[node[2:-2]]
        for k, v in values.items():
            node = node.replace("{{" + k + "}}", str(v))
        return node
    return node


def load_workflow(path: Path, values: dict) -> dict:
    with open(path, encoding="utf-8") as f:
        wf = json.load(f)
    wf.pop("_comment", None)
    filled = fill_template(wf, values)
    left = [s for s in json.dumps(filled, ensure_ascii=False).split("{{")[1:]]
    if left:
        names = sorted({s.split("}}")[0] for s in left})
        raise ValueError(f"В {path.name} остались незаполненные плейсхолдеры: {names}")
    return filled


class ComfyClient:
    def __init__(self, url: str, timeout: int = 600):
        self.url = url.rstrip("/")
        self.timeout = timeout
        self.client_id = uuid.uuid4().hex

    def _get(self, path: str) -> bytes:
        with urllib.request.urlopen(self.url + path, timeout=60) as r:
            return r.read()

    def _post_json(self, path: str, data: dict) -> dict:
        req = urllib.request.Request(
            self.url + path,
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"ComfyUI отклонил воркфлоу: {e.read().decode(errors='replace')}") from e

    def ping(self) -> dict:
        return json.loads(self._get("/system_stats"))

    def upload_image(self, img: Image.Image, name: str) -> str:
        """Загружает картинку в ComfyUI/input, возвращает имя для LoadImage."""
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"{name}\"\r\n"
            f"Content-Type: image/png\r\n\r\n"
        ).encode() + buf.getvalue() + (
            f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue"
            f"\r\n--{boundary}--\r\n"
        ).encode()
        req = urllib.request.Request(
            self.url + "/upload/image", data=body,
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
        )
        with urllib.request.urlopen(req, timeout=60) as r:
            res = json.loads(r.read())
        return (res.get("subfolder") + "/" if res.get("subfolder") else "") + res["name"]

    def run(self, workflow: dict) -> list[Image.Image]:
        """Ставит воркфлоу в очередь, ждёт и возвращает картинки из SaveImage."""
        prompt_id = self._post_json("/prompt", {"prompt": workflow, "client_id": self.client_id})["prompt_id"]
        start = time.time()
        while True:
            hist = json.loads(self._get(f"/history/{prompt_id}"))
            if prompt_id in hist:
                entry = hist[prompt_id]
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"Ошибка выполнения в ComfyUI: {status.get('messages')}")
                images = []
                for out in entry.get("outputs", {}).values():
                    for im in out.get("images", []):
                        if im.get("type") != "output":
                            continue
                        q = urllib.parse.urlencode(
                            {"filename": im["filename"], "subfolder": im["subfolder"], "type": im["type"]})
                        images.append(Image.open(io.BytesIO(self._get(f"/view?{q}"))).convert("RGB"))
                if images:
                    return images
            if time.time() - start > self.timeout:
                raise TimeoutError(f"ComfyUI не ответил за {self.timeout} с")
            time.sleep(1.0)
