from __future__ import annotations

import contextlib
import difflib
import hashlib
import json
import math
import os
import resource
import statistics
import subprocess
import sys
import time
import wave
from pathlib import Path
from typing import Any, NoReturn

import cv2
import numpy as np

ADMITTED_FPS = {24, 25, 30, 50, 60}
ANALYSIS_SIZE = (540, 960)
MAX_FRAMES = 240


class CompilerFailure(RuntimeError):
    pass


def fail(token: str) -> NoReturn:
    raise CompilerFailure(token)


def progress(stage: str, fraction: float) -> None:
    print(
        json.dumps(
            {
                "protocol": "rvs.compiler.v1",
                "kind": "progress",
                "stage": stage,
                "fraction": float(np.clip(fraction, 0, 1)),
            }
        ),
        file=sys.stderr,
        flush=True,
    )


def sha256(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def within(root: Path, candidate: Path) -> bool:
    try:
        candidate.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (FileNotFoundError, ValueError):
        return False
    return True


def verify_request(request: dict[str, Any]) -> tuple[Path, int, int]:
    if request.get("protocol") != "rvs.compiler.v1":
        fail("COMPILER_PROTOCOL_INVALID")
    root = Path(os.environ.get("RVS_TENANT_ROOT", ""))
    artifact = Path(str(request.get("artifactPath", "")))
    frame_count_value = request.get("frameCount")
    if not root or not within(root, artifact):
        fail("WORKSPACE_BOUNDARY_VIOLATION")
    if request.get("endMs", 0) - request.get("startMs", 0) != 4_000:
        fail("TEMPORAL_CONTRACT_INVALID")
    if (
        not isinstance(frame_count_value, int)
        or not 1 <= frame_count_value <= MAX_FRAMES
    ):
        fail("TEMPORAL_CONTRACT_INVALID")
    frame_count: int = frame_count_value
    capture = cv2.VideoCapture(str(artifact))
    if not capture.isOpened():
        fail("NORMALIZED_ARTIFACT_CORRUPT")
    fps: int = round(float(capture.get(cv2.CAP_PROP_FPS)))
    decoded: int = round(float(capture.get(cv2.CAP_PROP_FRAME_COUNT)))
    capture.release()
    if fps not in ADMITTED_FPS or frame_count != fps * 4 or decoded != frame_count:
        fail("NORMALIZED_ARTIFACT_CORRUPT")
    return artifact, frame_count, fps


def verify_models() -> None:
    if os.environ.get("RVS_COMPILER_SMOKE") == "1":
        return
    artifacts = Path(
        os.environ.get("RVS_MODEL_ARTIFACTS_DIR", "/opt/rvs/model-artifacts")
    )
    manifest = json.loads((Path(__file__).parent / "model-manifest.json").read_text())
    for model in manifest["models"]:
        path = artifacts / model["name"]
        if not path.is_file() or sha256(path) != model["sha256"]:
            fail("RUNTIME_PREREQUISITE_MISSING")


def load_models() -> dict[str, Any]:
    if os.environ.get("RVS_COMPILER_SMOKE") == "1":
        return {}
    model_dir = Path(os.environ.get("RVS_MODEL_DIR", "/opt/rvs/models"))
    vendor = Path(os.environ.get("RVS_VENDOR_DIR", "/opt/rvs/vendor"))
    with contextlib.redirect_stdout(sys.stderr):
        import easyocr
        import geffnet
        import torch

        sys.path.insert(0, str(vendor / "rvm"))
        from model import MattingNetwork

        rvm = MattingNetwork("mobilenetv3").eval()
        rvm.load_state_dict(
            torch.load(
                model_dir / "rvm_mobilenetv3.pth",
                map_location="cpu",
                weights_only=True,
            )
        )
        sys.path.insert(0, str(vendor / "midas"))
        import midas.blocks
        from midas.midas_net_custom import MidasNet_small

        def make_efficientnet(_use_pretrained: bool, exportable: bool = False) -> Any:
            network = geffnet.create_model(
                "tf_efficientnet_lite3",
                pretrained=False,
            )
            return midas.blocks._make_efficientnet_backbone(network)

        midas.blocks._make_pretrained_efficientnet_lite3 = make_efficientnet
        midas = MidasNet_small(
            str(model_dir / "midas_v21_small_256.pt"),
            features=64,
            backbone="efficientnet_lite3",
            exportable=True,
            non_negative=True,
            blocks={"expand": True},
        )
        midas.eval()
        ocr = easyocr.Reader(
            ["ko", "en"],
            gpu=False,
            model_storage_directory=str(model_dir / "easyocr"),
            download_enabled=False,
            verbose=False,
        )
    return {
        "torch": torch,
        "rvm": rvm,
        "midas": midas,
        "ocr": ocr,
    }


def bounds(points: Any, width: int, height: int) -> list[int]:
    values = np.asarray(points, dtype=np.float32).reshape(-1, 2)
    x1 = max(0, int(np.floor(values[:, 0].min())))
    y1 = max(0, int(np.floor(values[:, 1].min())))
    x2 = min(width, int(np.ceil(values[:, 0].max())))
    y2 = min(height, int(np.ceil(values[:, 1].max())))
    return [x1, y1, max(1, x2 - x1), max(1, y2 - y1)]


def detect_ocr(
    models: dict[str, Any], native: np.ndarray, analysis: np.ndarray, index: int
) -> list[dict[str, Any]]:
    if not models:
        return []
    native_height, native_width = native.shape[:2]
    analysis_height, analysis_width = analysis.shape[:2]
    with contextlib.redirect_stdout(sys.stderr):
        horizontal_groups, free_groups = models["ocr"].detect(
            analysis,
            canvas_size=max(analysis.shape[:2]),
            mag_ratio=1.0,
            max_candidates=64,
        )
        horizontal = [
            [
                round(box[0] * native_width / analysis_width),
                round(box[1] * native_width / analysis_width),
                round(box[2] * native_height / analysis_height),
                round(box[3] * native_height / analysis_height),
            ]
            for box in horizontal_groups[0]
        ]
        free = [
            [
                [
                    round(point[0] * native_width / analysis_width),
                    round(point[1] * native_height / analysis_height),
                ]
                for point in polygon
            ]
            for polygon in free_groups[0]
        ]
        results = models["ocr"].recognize(
            cv2.cvtColor(native, cv2.COLOR_BGR2GRAY),
            horizontal,
            free,
            detail=1,
            paragraph=False,
            batch_size=1,
            reformat=False,
        )
    found: list[dict[str, Any]] = []
    for polygon, text, confidence in results:
        clean = " ".join(str(text).split())
        box = bounds(polygon, native_width, native_height)
        if not clean or box[2] < 2 or box[3] < 2:
            continue
        found.append(
            {
                "frame": index,
                "text": clean,
                "confidence": float(np.clip(confidence, 0, 1)),
                "bounds": box,
                "provenance": f"native-frame:{index}",
            }
        )
    return found


def detect_surfaces(frame: np.ndarray, index: int) -> list[dict[str, Any]]:
    height, width = frame.shape[:2]
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 60, 160)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    surfaces: list[dict[str, Any]] = []
    for contour in contours:
        x, y, box_width, box_height = cv2.boundingRect(contour)
        area = box_width * box_height
        if area < width * height * 0.025 or area > width * height * 0.88:
            continue
        if box_width < width * 0.18 or box_height < height * 0.06:
            continue
        surfaces.append(
            {
                "frame": index,
                "bounds": [x, y, box_width, box_height],
                "confidence": 0.6,
            }
        )
    surfaces.sort(key=lambda item: item["bounds"][2] * item["bounds"][3], reverse=True)
    selected: list[dict[str, Any]] = []
    for surface in surfaces:
        if any(box_iou(surface["bounds"], item["bounds"]) >= 0.72 for item in selected):
            continue
        selected.append(surface)
    return selected[:4]


def camera_measure(
    previous: np.ndarray | None, current: np.ndarray
) -> dict[str, float]:
    empty = {
        "tx": 0.0,
        "ty": 0.0,
        "rotation": 0.0,
        "scale": 1.0,
        "inlierRatio": 0.0,
    }
    if previous is None:
        return {**empty, "inlierRatio": 1.0}
    orb = getattr(cv2, "ORB_create")(800)
    before_points, before_descriptors = orb.detectAndCompute(previous, None)
    after_points, after_descriptors = orb.detectAndCompute(current, None)
    if before_descriptors is None or after_descriptors is None:
        return empty
    matches = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(
        before_descriptors, after_descriptors
    )
    matches = sorted(matches, key=lambda match: match.distance)[:200]
    if len(matches) < 8:
        return empty
    source = np.asarray(
        [before_points[match.queryIdx].pt for match in matches], dtype=np.float32
    )
    target = np.asarray(
        [after_points[match.trainIdx].pt for match in matches], dtype=np.float32
    )
    matrix, mask = cv2.findHomography(source, target, cv2.RANSAC, 3.0)
    if matrix is None or mask is None:
        return empty
    scale = math.sqrt(float(matrix[0, 0]) ** 2 + float(matrix[1, 0]) ** 2)
    rotation = math.degrees(math.atan2(float(matrix[1, 0]), float(matrix[0, 0])))
    return {
        "tx": float(matrix[0, 2]),
        "ty": float(matrix[1, 2]),
        "rotation": rotation,
        "scale": scale,
        "inlierRatio": float(mask.mean()),
    }


def matte_measure(
    models: dict[str, Any], frame: np.ndarray, recurrent: list[Any]
) -> tuple[dict[str, Any], list[Any]]:
    if not models:
        return {"coverage": 0.0, "bounds": None}, recurrent
    torch = models["torch"]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    tensor = torch.from_numpy(rgb).permute(2, 0, 1).unsqueeze(0).float() / 255.0
    with torch.no_grad():
        _, alpha, *next_recurrent = models["rvm"](
            tensor,
            *recurrent,
            downsample_ratio=min(1.0, 256 / min(frame.shape[:2])),
        )
    matte = alpha[0, 0].cpu().numpy()
    mask = matte >= 0.5
    if not mask.any():
        return {"coverage": 0.0, "bounds": None}, next_recurrent
    ys, xs = np.where(mask)
    return {
        "coverage": float(mask.mean()),
        "bounds": [
            int(xs.min()),
            int(ys.min()),
            int(xs.max() - xs.min() + 1),
            int(ys.max() - ys.min() + 1),
        ],
    }, next_recurrent


def depth_measure(models: dict[str, Any], frame: np.ndarray) -> float | None:
    if not models:
        return None
    torch = models["torch"]
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    height, width = rgb.shape[:2]
    scale = min(256 / width, 256 / height)
    target_width = max(32, round(width * scale / 32) * 32)
    target_height = max(32, round(height * scale / 32) * 32)
    transformed = cv2.resize(
        rgb, (target_width, target_height), interpolation=cv2.INTER_CUBIC
    )
    transformed = (transformed - np.asarray([0.485, 0.456, 0.406])) / np.asarray(
        [0.229, 0.224, 0.225]
    )
    transformed = np.ascontiguousarray(transformed.transpose(2, 0, 1)).astype(
        np.float32
    )
    sample = torch.from_numpy(transformed).unsqueeze(0)
    with torch.no_grad():
        prediction = models["midas"](sample)
        prediction = torch.nn.functional.interpolate(
            prediction.unsqueeze(1),
            size=frame.shape[:2],
            mode="bicubic",
            align_corners=False,
        ).squeeze()
    values = prediction.cpu().numpy()
    low, high = np.percentile(values, [2, 98])
    normalized = np.clip((values - low) / max(high - low, 1e-6), 0, 1)
    return float(np.median(normalized))


def visual_measure(frame: np.ndarray) -> dict[str, Any]:
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    luminance = gray.astype(np.float32) / 255.0
    cells = cv2.resize(luminance, (16, 9), interpolation=cv2.INTER_AREA)
    rgb_cells = cv2.resize(rgb, (16, 9), interpolation=cv2.INTER_AREA)
    activity = float(cv2.Laplacian(gray, cv2.CV_32F).var())
    return {
        "meanRgb": [float(value) for value in rgb.reshape(-1, 3).mean(axis=0)],
        "activity": activity,
        "bloom": float((luminance > 0.88).mean()),
        "defocusSigma": float(1 / math.sqrt(max(activity, 1e-6))),
        "rim": float(cv2.Canny(gray, 80, 180).mean() / 255),
        "lowerLight16x9": [float(value) for value in cells.reshape(-1)],
        "lowerLightRgb16x9": [float(value) / 255 for value in rgb_cells.reshape(-1)],
    }


def owner_effect_measure(frame: np.ndarray, box: list[int]) -> dict[str, float]:
    x, y, width, height = box
    crop = frame[y : y + height, x : x + width]
    if crop.size == 0:
        fail("OWNER_MEASUREMENT_FAILED")
    measured = visual_measure(crop)
    return {
        "bloom": float(np.clip(measured["bloom"], 0, 1)),
        "defocus": float(np.clip(measured["defocusSigma"], 0, 1)),
        "rim": float(np.clip(measured["rim"], 0, 1)),
    }


def derive_palette(measurements: list[dict[str, Any]]) -> list[str]:
    colors = np.asarray([entry["meanRgb"] for entry in measurements], dtype=np.float32)
    return [
        "#" + "".join(f"{int(np.clip(value, 0, 255)):02x}" for value in color)
        for color in (
            np.percentile(colors, 25, axis=0),
            np.percentile(colors, 85, axis=0),
        )
    ]


def analyze_audio(
    artifact: Path, workspace: Path, fps: int, frame_count: int
) -> list[dict[str, Any]]:
    audio = workspace / "compiler-audio.wav"
    result = subprocess.run(
        [
            os.environ.get("RVS_FFMPEG_PATH", "ffmpeg"),
            "-nostdin",
            "-y",
            "-i",
            str(artifact),
            "-map",
            "0:a:0",
            "-vn",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            str(audio),
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    if result.returncode != 0:
        fail("AUDIO_MEASUREMENT_FAILED")
    with wave.open(str(audio), "rb") as source:
        if source.getframerate() != 48_000 or source.getnchannels() != 2:
            fail("AUDIO_MEASUREMENT_FAILED")
        samples = np.frombuffer(
            source.readframes(source.getnframes()), dtype="<i2"
        ).reshape(-1, 2)
    window = max(1, 48_000 // fps)
    energy = np.asarray(
        [
            np.abs(samples[start : start + window]).mean()
            for start in range(0, len(samples), window)
        ]
    )
    changes = np.abs(np.diff(energy, prepend=energy[0]))
    peaks = np.argsort(changes)[-min(5, frame_count) :]
    return [
        {
            "frame": int(frame),
            "sample": round(int(frame) / fps * 48_000),
            "levelDb": float(20 * math.log10(max(float(energy[frame]), 1) / 32768)),
            "confidence": float(changes[frame] / max(float(changes.max()), 1)),
        }
        for frame in sorted(peaks)
        if frame < frame_count
    ]


def normalized_text(value: str) -> str:
    return "".join(character.casefold() for character in value if character.isalnum())


def representative_text(samples: list[dict[str, Any]]) -> dict[str, Any]:
    return max(
        samples,
        key=lambda sample: (
            float(sample["confidence"]) * len(normalized_text(sample["text"])),
            float(sample["confidence"]),
        ),
    )


def track_text(candidates: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    grouped: list[list[dict[str, Any]]] = []
    for candidate in sorted(candidates, key=lambda item: item["frame"]):
        normalized = normalized_text(candidate["text"])
        if len(normalized) < 2:
            continue
        box = candidate["bounds"]
        center = (box[0] + box[2] / 2, box[1] + box[3] / 2)
        best_group: list[dict[str, Any]] | None = None
        best_score = 0.0
        for group in grouped:
            representative = representative_text(group)
            prior = representative["bounds"]
            prior_text = normalized_text(representative["text"])
            similarity = difflib.SequenceMatcher(None, normalized, prior_text).ratio()
            prefix_match = min(len(normalized), len(prior_text)) >= 4 and (
                normalized.startswith(prior_text) or prior_text.startswith(normalized)
            )
            distance = math.hypot(
                center[0] - (prior[0] + prior[2] / 2),
                center[1] - (prior[1] + prior[3] / 2),
            )
            spatial_limit = max(box[2], box[3], prior[2], prior[3]) * 1.25
            if (similarity >= 0.55 or prefix_match) and distance <= spatial_limit:
                score = similarity - distance / max(spatial_limit, 1) * 0.15
                if score > best_score:
                    best_group = group
                    best_score = score
        if best_group is None:
            grouped.append([candidate])
        elif all(sample["frame"] != candidate["frame"] for sample in best_group):
            best_group.append(candidate)
        else:
            existing = next(
                sample for sample in best_group if sample["frame"] == candidate["frame"]
            )
            if candidate["confidence"] > existing["confidence"]:
                best_group[best_group.index(existing)] = candidate
    return sorted(
        (group for group in grouped if len({sample["frame"] for sample in group}) >= 2),
        key=lambda group: (
            len(group),
            statistics.median(item["confidence"] for item in group),
        ),
        reverse=True,
    )[:20]


def track_surfaces(
    candidates: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    grouped: list[list[dict[str, Any]]] = []
    for candidate in sorted(
        candidates,
        key=lambda item: (
            item["frame"],
            -(item["bounds"][2] * item["bounds"][3]),
        ),
    ):
        best_group: list[dict[str, Any]] | None = None
        best_iou = 0.25
        for group in grouped:
            previous = group[-1]
            gap = candidate["frame"] - previous["frame"]
            overlap = box_iou(candidate["bounds"], previous["bounds"])
            if 1 <= gap <= 12 and overlap > best_iou:
                best_group = group
                best_iou = overlap
        if best_group is None:
            grouped.append([candidate])
        else:
            best_group.append(candidate)
    return sorted(
        (group for group in grouped if len(group) >= 2),
        key=len,
        reverse=True,
    )[:6]


def box_iou(left: list[int], right: list[int]) -> float:
    x1 = max(left[0], right[0])
    y1 = max(left[1], right[1])
    x2 = min(left[0] + left[2], right[0] + right[2])
    y2 = min(left[1] + left[3], right[1] + right[3])
    if x2 <= x1 or y2 <= y1:
        return 0.0
    intersection = (x2 - x1) * (y2 - y1)
    return intersection / (left[2] * left[3] + right[2] * right[3] - intersection)


def lifecycle(samples: list[dict[str, Any]], frame_count: int) -> dict[str, Any]:
    start = min(sample["frame"] for sample in samples)
    end = max(sample["frame"] for sample in samples)
    return {
        "enter": {
            "start": start,
            "end": min(start + 6, end),
            "easing": "measured-entry",
        },
        "stable": {
            "start": min(start + 1, end),
            "end": end,
            "easing": "measured",
        },
        "exit": {
            "start": min(end + 1, frame_count),
            "end": min(end + 1, frame_count),
            "observed": end < frame_count - 1,
        },
    }


def map_bounds(sample: dict[str, Any]) -> dict[str, int]:
    box = sample["bounds"]
    return {
        "frame": sample["frame"],
        "x": round(box[0] * 1080 / sample["canvasWidth"]),
        "y": round(box[1] * 1920 / sample["canvasHeight"]),
        "width": round(box[2] * 1080 / sample["canvasWidth"]),
        "height": round(box[3] * 1920 / sample["canvasHeight"]),
    }


def scene_input(
    request: dict[str, Any],
    frame_count: int,
    fps: int,
    text_tracks: list[list[dict[str, Any]]],
    surface_tracks: list[list[dict[str, Any]]],
    audio: list[dict[str, Any]],
    colors: list[str],
) -> dict[str, Any]:
    def effect_samples(samples: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
        return [
            {"frame": sample["frame"], "value": sample["ownerEffects"][name]}
            for sample in sorted(samples, key=lambda sample: sample["frame"])
        ]

    owners: list[dict[str, Any]] = [
        {
            "ownerId": "global-residual",
            "kind": "residual-canvas",
            "editable": True,
            "assetRef": "asset-global-residual",
            "confidence": 1.0,
        }
    ]
    assets: list[dict[str, Any]] = [
        {
            "assetId": "asset-global-residual",
            "kind": "measured-background",
            "editable": True,
            "owner": "global-residual",
            "palette": colors,
        }
    ]
    geometry: dict[str, Any] = {
        "global-residual": {
            "boundsPerFrame": [
                {"frame": 0, "x": 0, "y": 0, "width": 1080, "height": 1920},
                {
                    "frame": frame_count - 1,
                    "x": 0,
                    "y": 0,
                    "width": 1080,
                    "height": 1920,
                },
            ],
            "fixedWidth": True,
            "fixedX": True,
        }
    }
    tracks: list[dict[str, Any]] = [
        {
            "trackId": "track-global-residual",
            "owner": "global-residual",
            "lifecycle": {
                "enter": {"start": 0},
                "stable": {"start": 0},
                "exit": {"start": frame_count},
            },
            "geometryRef": "global-residual",
            "effects": ["residual-canvas"],
        }
    ]
    effects: dict[str, Any] = {
        "global-residual": {
            "residual-canvas": {
                "source": "all-frame color and lower-light measurements"
            }
        }
    }
    text_ids: list[str] = []
    surface_ids: list[str] = []
    for index, samples in enumerate(text_tracks):
        owner_id = f"text-{index:02d}"
        asset_id = f"asset-{owner_id}"
        text_ids.append(owner_id)
        representative = representative_text(samples)
        owners.append(
            {
                "ownerId": owner_id,
                "kind": "product-copy",
                "editable": True,
                "assetRef": asset_id,
                "confidence": statistics.median(
                    float(sample["confidence"]) for sample in samples
                ),
                "content": representative["text"].lstrip("'\"~( "),
            }
        )
        assets.append(
            {
                "assetId": asset_id,
                "kind": "measured-text",
                "editable": True,
                "owner": owner_id,
            }
        )
        geometry[owner_id] = {
            "boundsPerFrame": [
                map_bounds(sample)
                for sample in sorted(samples, key=lambda sample: sample["frame"])
            ],
            "fixedWidth": False,
            "fixedX": False,
        }
        tracks.append(
            {
                "trackId": f"track-{owner_id}",
                "owner": owner_id,
                "lifecycle": lifecycle(samples, frame_count),
                "geometryRef": owner_id,
                "effects": ["bloom", "defocus"],
            }
        )
        effects[owner_id] = {
            "bloom": {
                "source": "native owner luminance profile",
                "samples": effect_samples(samples, "bloom"),
            },
            "defocus": {
                "source": "native owner Laplacian profile",
                "samples": effect_samples(samples, "defocus"),
            },
        }
    for index, samples in enumerate(surface_tracks):
        owner_id = f"ui-surface-{index:02d}"
        asset_id = f"asset-{owner_id}"
        surface_ids.append(owner_id)
        owners.append(
            {
                "ownerId": owner_id,
                "kind": "product-ui",
                "editable": True,
                "assetRef": asset_id,
                "confidence": min(float(sample["confidence"]) for sample in samples),
            }
        )
        assets.append(
            {
                "assetId": asset_id,
                "kind": "semantic-ui-surface",
                "editable": True,
                "owner": owner_id,
            }
        )
        geometry[owner_id] = {
            "boundsPerFrame": [map_bounds(sample) for sample in samples],
            "fixedWidth": False,
            "fixedX": False,
        }
        tracks.append(
            {
                "trackId": f"track-{owner_id}",
                "owner": owner_id,
                "lifecycle": lifecycle(samples, frame_count),
                "geometryRef": owner_id,
                "effects": ["rim", "bloom", "defocus"],
            }
        )
        effects[owner_id] = {
            "rim": {
                "source": "native owner edge profile",
                "samples": effect_samples(samples, "rim"),
            },
            "bloom": {
                "source": "native owner luminance profile",
                "samples": effect_samples(samples, "bloom"),
            },
            "defocus": {
                "source": "native owner Laplacian profile",
                "samples": effect_samples(samples, "defocus"),
            },
        }
    passes: list[dict[str, Any]] = [
        {
            "passId": "background-dom",
            "owner": "global-residual",
            "kind": "DOM/SVG",
            "shader": None,
            "reads": ["asset-global-residual"],
            "writes": "background-layer",
        },
        {
            "passId": "residual-gradient",
            "owner": "global-residual",
            "kind": "WebGL2",
            "shader": "residual-gradient",
            "reads": ["residualCanvas.gradient mesh"],
            "writes": "background-layer",
        },
        {
            "passId": "residual-light-pool",
            "owner": "global-residual",
            "kind": "WebGL2",
            "shader": "residual-light-pool",
            "reads": ["residualCanvas.light pool"],
            "writes": "background-layer",
        },
        {
            "passId": "residual-sparkles",
            "owner": "global-residual",
            "kind": "WebGL2",
            "shader": "residual-sparkles",
            "reads": ["residualCanvas.sparkles"],
            "writes": "background-layer",
        },
        {
            "passId": "lower-light-behind-ui",
            "owner": "global-residual",
            "kind": "WebGL2",
            "shader": "lower-light-field-13tap",
            "reads": ["residualCanvas.lower-light field"],
            "writes": "behind-ui-layer",
        },
    ]
    if surface_ids:
        passes.append(
            {
                "passId": "semantic-ui-dom",
                "owner": ",".join(surface_ids),
                "kind": "DOM/SVG",
                "shader": None,
                "reads": ["measured UI bounds"],
                "writes": "semantic-ui-layer",
            }
        )
    if text_ids:
        passes.append(
            {
                "passId": "copy-dom",
                "owner": ",".join(text_ids),
                "kind": "DOM/SVG",
                "shader": None,
                "reads": ["native OCR"],
                "writes": "copy-layer",
            }
        )
    treatment_ids = [*text_ids, *surface_ids]
    if treatment_ids:
        passes.append(
            {
                "passId": "owner-bloom-defocus",
                "owner": ",".join(treatment_ids),
                "kind": "WebGL2",
                "shader": "owner-bloom-defocus",
                "reads": ["owner effect samples"],
                "writes": "owner-treatment-layer",
            }
        )
    if surface_ids:
        passes.append(
            {
                "passId": "dynamic-nonuniform-rim",
                "owner": ",".join(surface_ids),
                "kind": "WebGL2",
                "shader": "dynamic-nonuniform-rim",
                "reads": ["owner bounds", "edge-rim profile"],
                "writes": "over-ui-layer",
            }
        )
    passes.append(
        {
            "passId": "lower-light-over-ui",
            "owner": "global-residual",
            "kind": "WebGL2",
            "shader": "lower-light-field-13tap",
            "reads": ["residualCanvas.lower-light field"],
            "writes": "over-ui-layer",
        }
    )
    passes.append(
        {
            "passId": "final-composite",
            "owner": "global-residual",
            "kind": "WebGL2",
            "shader": "display-referred-soft-toe-024",
            "reads": ["all prior layers"],
            "writes": "final-frame",
        }
    )
    return {
        "tenantId": request["tenantId"],
        "editor": "reference-compiler",
        "reason": "measured reference evidence",
        "timestamp": "1970-01-01T00:00:00.000Z",
        "gate": "PENDING",
        "needsChoice": [],
        "owners": owners,
        "editableAssets": assets,
        "geometry": geometry,
        "tracks": tracks,
        "effects": effects,
        "residualCanvas": {
            "owner": "global-residual",
            "measurements": [
                "gradient mesh",
                "light pool",
                "sparkles",
                "lower-light field",
            ],
            "mustRemainSeparate": True,
            "compositeRule": "background then semantic owners then final composite",
        },
        "audio": {
            "sampleRateHz": 48_000,
            "channels": 2,
            "frameRate": fps,
            "anchors": [
                {
                    "anchorId": f"audio-{entry['frame']}",
                    "frame": entry["frame"],
                    "sample": entry["sample"],
                    "owner": "global-residual",
                    "role": "measured activity peak",
                    "confidence": entry["confidence"],
                }
                for entry in audio
            ],
        },
        "passes": passes,
        "layerOrder": [
            "background-layer",
            "behind-ui-layer",
            "semantic-ui-layer",
            "copy-layer",
            "owner-treatment-layer",
            "over-ui-layer",
            "final-frame",
        ],
        "allowedShaders": [
            "dynamic-nonuniform-rim",
            "owner-bloom-defocus",
            "lower-light-field-13tap",
            "residual-gradient",
            "residual-light-pool",
            "residual-sparkles",
            "display-referred-soft-toe-024",
        ],
    }


def compile_bundle(
    request: dict[str, Any], artifact: Path, frame_count: int, fps: int
) -> dict[str, Any]:
    progress("models", 0.02)
    models = load_models()
    capture = cv2.VideoCapture(str(artifact))
    ocr: list[dict[str, Any]] = []
    surfaces: list[dict[str, Any]] = []
    camera: list[dict[str, float]] = []
    mattes: list[dict[str, Any]] = []
    depths: list[float | None] = []
    visual: list[dict[str, Any]] = []
    frames: list[dict[str, Any]] = []
    previous_gray: np.ndarray | None = None
    recurrent: list[Any] = [None, None, None, None]
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    for index in range(frame_count):
        ok, native = capture.read()
        if not ok:
            capture.release()
            fail("MISSING_TEMPORAL_FRAME")
        analysis = cv2.resize(native, ANALYSIS_SIZE, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(analysis, cv2.COLOR_BGR2GRAY)
        frame_ocr = detect_ocr(models, native, analysis, index)
        frame_surfaces = detect_surfaces(native, index)
        for candidate in [*frame_ocr, *frame_surfaces]:
            candidate["canvasWidth"] = width
            candidate["canvasHeight"] = height
            candidate["ownerEffects"] = owner_effect_measure(
                native, candidate["bounds"]
            )
        ocr.extend(frame_ocr)
        surfaces.extend(frame_surfaces)
        camera.append(camera_measure(previous_gray, gray))
        matte, recurrent = matte_measure(models, analysis, recurrent)
        mattes.append(matte)
        depths.append(depth_measure(models, analysis))
        visual.append(visual_measure(analysis))
        frames.append(
            {
                "index": index,
                "timeMs": int(index * 1_000 / fps),
                "nativeSha256": hashlib.sha256(native.tobytes()).hexdigest(),
            }
        )
        previous_gray = gray
        if index == frame_count - 1 or index % max(1, frame_count // 20) == 0:
            progress(
                "all-frame-analysis", 0.02 + (index + 1) / frame_count * 0.88
            )
    if capture.read()[0]:
        capture.release()
        fail("NORMALIZED_ARTIFACT_CORRUPT")
    capture.release()
    audio = analyze_audio(
        artifact, Path(request["artifactPath"]).parent, fps, frame_count
    )
    progress("audio-and-mapping", 0.95)
    colors = derive_palette(visual)
    text_tracks = track_text(ocr)
    surface_tracks = track_surfaces(surfaces)
    return {
        "schemaVersion": "rvs-reference-evidence-v1",
        "state": "MAPPED",
        "source": {
            "jobId": request["jobId"],
            "attemptId": request["attemptId"],
            "normalizedSha256": sha256(artifact),
        },
        "observed": {
            "temporalVolume": {
                "profile": "540x960",
                "fps": fps,
                "frameCount": frame_count,
                "intervalMs": [0, 4_000],
                "frames": frames,
            },
            "ocr": {"engine": "EasyOCR ko+en", "candidates": ocr},
            "uiSurfaces": surfaces,
            "matting": {"engine": "RVM MobileNetV3", "frames": mattes},
            "depth": {
                "engine": "MiDaS v2.1 small",
                "medianNormalized": depths,
            },
            "camera": {
                "method": "RANSAC background homography",
                "units": {
                    "translation": "px/frame",
                    "rotation": "deg/frame",
                    "scale": "multiplicative/frame",
                },
                "frames": camera,
            },
            "effects": visual,
            "audio": {
                "sampleRateHz": 48_000,
                "channels": 2,
                "anchors": audio,
            },
            "palette": colors,
        },
        "mappings": {
            "textOwnerCount": len(text_tracks),
            "uiOwnerCount": len(surface_tracks),
            "residualOwner": "global-residual",
        },
        "needsChoice": [],
        "sceneInput": scene_input(
            request,
            frame_count,
            fps,
            text_tracks,
            surface_tracks,
            audio,
            colors,
        ),
    }


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    started = time.monotonic()
    try:
        request = json.loads(Path(sys.argv[1]).read_text())
        artifact, frame_count, fps = verify_request(request)
        verify_models()
        progress("preflight", 0.01)
        bundle = compile_bundle(request, artifact, frame_count, fps)
        progress("evidence", 1.0)
        output = {
            "protocol": "rvs.compiler.v1",
            "kind": "evidence",
            "bundle": bundle,
            "stages": [
                {
                    "name": "all-frame-analysis",
                    "seconds": time.monotonic() - started,
                }
            ],
            "rssGib": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024 / 1024,
        }
        encoded = json.dumps(output, ensure_ascii=False, separators=(",", ":"))
        Path(sys.argv[2]).write_text(encoded)
        print(encoded)
        return 0
    except (
        CompilerFailure,
        KeyError,
        TypeError,
        ValueError,
        json.JSONDecodeError,
    ) as error:
        token = (
            str(error)
            if isinstance(error, CompilerFailure)
            else "COMPILER_PROTOCOL_INVALID"
        )
        print(json.dumps({"event": "compiler.failed", "token": token}), file=sys.stderr)
        return 1
    except (AttributeError, ImportError, OSError, RuntimeError, cv2.error):
        print(
            json.dumps(
                {"event": "compiler.failed", "token": "COMPILER_PIPELINE_FAILED"}
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
