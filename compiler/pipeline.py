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
    previous: np.ndarray | None,
    current: np.ndarray,
    foreground_bounds: list[int] | None,
    fps: int,
) -> dict[str, float]:
    empty = {
        "panXPxPerMs": 0.0,
        "panYPxPerMs": 0.0,
        "tiltDegPerMs": 0.0,
        "zoomScalePerMs": 0.0,
        "confidence": 0.0,
    }
    if previous is None:
        return {**empty, "confidence": 1.0}
    feature_mask = np.full(current.shape, 255, dtype=np.uint8)
    if foreground_bounds is not None:
        x, y, width, height = foreground_bounds
        feature_mask[y : y + height, x : x + width] = 0
    orb = getattr(cv2, "ORB_create")(800)
    before_points, before_descriptors = orb.detectAndCompute(previous, feature_mask)
    after_points, after_descriptors = orb.detectAndCompute(current, feature_mask)
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
    frame_ms = 1_000 / fps
    return {
        "panXPxPerMs": float(matrix[0, 2]) / frame_ms,
        "panYPxPerMs": float(matrix[1, 2]) / frame_ms,
        "tiltDegPerMs": rotation / frame_ms,
        "zoomScalePerMs": (scale - 1) / frame_ms,
        "confidence": float(mask.mean()),
    }


def matte_measure(
    models: dict[str, Any], frame: np.ndarray, recurrent: list[Any]
) -> tuple[dict[str, Any], list[Any]]:
    if not models:
        return {"coverage": 0.0, "bounds": None, "confidence": 0.0}, recurrent
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
        return {"coverage": 0.0, "bounds": None, "confidence": 1.0}, next_recurrent
    ys, xs = np.where(mask)
    return {
        "coverage": float(mask.mean()),
        "confidence": float(matte[mask].mean()),
        "bounds": [
            int(xs.min()),
            int(ys.min()),
            int(xs.max() - xs.min() + 1),
            int(ys.max() - ys.min() + 1),
        ],
    }, next_recurrent


def depth_measure(models: dict[str, Any], frame: np.ndarray) -> np.ndarray | None:
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
    return normalized


def region_median(
    field: np.ndarray | None,
    box: list[int] | None,
    source_width: int,
    source_height: int,
) -> float | None:
    if field is None or box is None:
        return None
    field_height, field_width = field.shape[:2]
    x, y, width, height = box
    x1 = int(np.clip(x * field_width / source_width, 0, field_width - 1))
    y1 = int(np.clip(y * field_height / source_height, 0, field_height - 1))
    x2 = int(np.clip((x + width) * field_width / source_width, x1 + 1, field_width))
    y2 = int(np.clip((y + height) * field_height / source_height, y1 + 1, field_height))
    return float(np.median(field[y1:y2, x1:x2]))


def lower_light_grid(rgb: np.ndarray) -> list[float]:
    height, width = rgb.shape[:2]
    x_edges = np.linspace(0, width, 17, dtype=int)
    y_edges = np.linspace(0, height, 10, dtype=int)
    return [
        float(value) / 255
        for row in range(9)
        for column in range(16)
        for value in np.median(
            rgb[
                y_edges[row] : y_edges[row + 1],
                x_edges[column] : x_edges[column + 1],
            ],
            axis=(0, 1),
        )
    ]


def visual_measure(frame: np.ndarray) -> dict[str, Any]:
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    luminance = gray.astype(np.float32) / 255.0
    cells = cv2.resize(luminance, (16, 9), interpolation=cv2.INTER_AREA)
    activity = float(cv2.Laplacian(gray, cv2.CV_32F).var())
    return {
        "meanRgb": [float(value) for value in rgb.reshape(-1, 3).mean(axis=0)],
        "activity": activity,
        "bloom": float((luminance > 0.88).mean()),
        "defocusSigma": float(1 / math.sqrt(max(activity, 1e-6))),
        "rim": float(cv2.Canny(gray, 80, 180).mean() / 255),
        "lowerLight16x9": [float(value) for value in cells.reshape(-1)],
        "lowerLightRgb16x9": lower_light_grid(rgb),
        "confidence": 1.0,
        "formulas": {
            "bloom": "fraction(luma > 0.88)",
            "defocus": "1/sqrt(var(laplacian))",
            "rim": "mean(canny(80,180))/255",
            "lowerLight": "median RGB per 16x9 cell",
        },
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
        "confidence": 1.0,
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
    scale = min(1080 / sample["canvasWidth"], 1920 / sample["canvasHeight"])
    offset_x = (1080 - sample["canvasWidth"] * scale) / 2
    offset_y = (1920 - sample["canvasHeight"] * scale) / 2
    return {
        "frame": sample["frame"],
        "x": round(offset_x + box[0] * scale),
        "y": round(offset_y + box[1] * scale),
        "width": round(box[2] * scale),
        "height": round(box[3] * scale),
    }


def interpolate_track(
    samples: list[dict[str, Any]], fps: int
) -> list[dict[str, Any]]:
    ordered = sorted(samples, key=lambda sample: sample["frame"])
    if len(ordered) < 2:
        return ordered
    exact = {int(sample["frame"]): sample for sample in ordered}
    result: list[dict[str, Any]] = []
    for frame in range(int(ordered[0]["frame"]), int(ordered[-1]["frame"]) + 1):
        if frame in exact:
            result.append(exact[frame])
            continue
        left = max(
            (sample for sample in ordered if int(sample["frame"]) < frame),
            key=lambda sample: int(sample["frame"]),
        )
        right = min(
            (sample for sample in ordered if int(sample["frame"]) > frame),
            key=lambda sample: int(sample["frame"]),
        )
        span = int(right["frame"]) - int(left["frame"])
        ratio = (frame - int(left["frame"])) / span

        def blend(left_value: float, right_value: float) -> float:
            return left_value + (right_value - left_value) * ratio

        box = [
            round(blend(float(left["bounds"][index]), float(right["bounds"][index])))
            for index in range(4)
        ]
        effects = {
            name: blend(
                float(left["ownerEffects"][name]),
                float(right["ownerEffects"][name]),
            )
            for name in ("bloom", "defocus", "rim")
        }
        result.append(
            {
                **left,
                "frame": frame,
                "bounds": box,
                "confidence": min(
                    float(left.get("confidence", 0)),
                    float(right.get("confidence", 0)),
                ),
                "ownerEffects": {
                    **effects,
                    "confidence": min(
                        float(left["ownerEffects"]["confidence"]),
                        float(right["ownerEffects"]["confidence"]),
                    ),
                },
                "depth": (
                    None
                    if left.get("depth") is None or right.get("depth") is None
                    else blend(float(left["depth"]), float(right["depth"]))
                ),
                "interpolated": True,
                "timeMs": round(frame * 1_000 / fps),
            }
        )
    return result


def tracking_measurements(
    owner_id: str, samples: list[dict[str, Any]], fps: int
) -> dict[str, Any]:
    measured: list[dict[str, Any]] = []
    previous_centroid: tuple[float, float] | None = None
    frame_ms = 1_000 / fps
    for sample in samples:
        mapped = map_bounds(sample)
        centroid = (
            mapped["x"] + mapped["width"] / 2,
            mapped["y"] + mapped["height"] / 2,
        )
        velocity = (
            [0.0, 0.0]
            if previous_centroid is None
            else [
                (centroid[0] - previous_centroid[0]) / frame_ms,
                (centroid[1] - previous_centroid[1]) / frame_ms,
            ]
        )
        measured.append(
            {
                "frame": sample["frame"],
                "timeMs": round(int(sample["frame"]) * frame_ms),
                "boundsPx": [
                    mapped["x"],
                    mapped["y"],
                    mapped["width"],
                    mapped["height"],
                ],
                "centroidPx": list(centroid),
                "velocityPxPerMs": velocity,
                "confidence": float(sample.get("confidence", 0)),
                "depthNormalized": sample.get("depth"),
            }
        )
        previous_centroid = centroid
    return {"ownerId": owner_id, "samples": measured}


def depth_overlap_choice(
    tracks: list[tuple[str, list[dict[str, Any]]]],
) -> dict[str, str] | None:
    for left_index, (left_id, left_samples) in enumerate(tracks):
        left_by_frame = {sample["frame"]: sample for sample in left_samples}
        for right_id, right_samples in tracks[left_index + 1 :]:
            for right in right_samples:
                left = left_by_frame.get(right["frame"])
                if (
                    left is not None
                    and left.get("depth") is not None
                    and right.get("depth") is not None
                    and box_iou(left["bounds"], right["bounds"]) > 0.05
                    and abs(float(left["depth"]) - float(right["depth"])) < 0.05
                ):
                    return {
                        "state": "NEEDS_CHOICE",
                        "choiceId": "choice_depth_overlap_ownership",
                        "reason": f"unclassified-depth-overlap:{left_id}:{right_id}",
                    }
    return None


def rhythm_measurements(
    visual: list[dict[str, Any]],
    audio: list[dict[str, Any]],
    fps: int,
) -> dict[str, Any]:
    activity = np.asarray([float(sample["activity"]) for sample in visual])
    changes = np.abs(np.diff(activity, prepend=activity[0]))
    visual_frames = set(int(index) for index in np.argsort(changes)[-min(5, len(changes)) :])
    audio_frames = {int(anchor["frame"]) for anchor in audio}
    beats = [
        {
            "frame": frame,
            "timeMs": round(frame * 1_000 / fps),
            "anchors": [
                *( ["visual-change"] if frame in visual_frames else [] ),
                *( ["audio-cue"] if frame in audio_frames else [] ),
            ],
            "confidence": float(
                max(
                    changes[frame] / max(float(changes.max()), 1e-6),
                    next(
                        (
                            anchor["confidence"]
                            for anchor in audio
                            if int(anchor["frame"]) == frame
                        ),
                        0,
                    ),
                )
            ),
        }
        for frame in sorted(visual_frames | audio_frames)
    ]
    intervals = np.diff([beat["timeMs"] for beat in beats])
    tempo = (
        None
        if len(intervals) == 0 or float(np.median(intervals)) <= 0
        else 60_000 / float(np.median(intervals))
    )
    return {
        "beats": beats,
        "tempoBpm": tempo,
        "easing": {
            "candidate": "linear" if float(np.std(changes)) < 1e-6 else "ease-in-out",
            "source": "all-frame visual activity derivative",
            "confidence": 1.0,
        },
    }


def scene_input(
    request: dict[str, Any],
    frame_count: int,
    fps: int,
    text_tracks: list[list[dict[str, Any]]],
    surface_tracks: list[list[dict[str, Any]]],
    audio: list[dict[str, Any]],
    colors: list[str],
    mattes: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    def effect_confidence(sample: dict[str, Any]) -> float:
        return float(
            sample["ownerEffects"].get("confidence", sample.get("confidence", 0))
        )

    def effect_samples(samples: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
        return [
            {
                "frame": sample["frame"],
                "value": sample["ownerEffects"][name],
                "confidence": effect_confidence(sample),
            }
            for sample in sorted(samples, key=lambda sample: sample["frame"])
        ]

    owners: list[dict[str, Any]] = [
        {
            "ownerId": "global-residual",
            "kind": "global-residual",
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
    matte_frames = mattes or []
    foreground_samples = [
        {
            **matte,
            "canvasWidth": ANALYSIS_SIZE[0],
            "canvasHeight": ANALYSIS_SIZE[1],
        }
        for matte in matte_frames
        if matte["bounds"] is not None and 0.05 <= matte["coverage"] <= 0.75
    ]
    foreground_confidence = len(foreground_samples) / max(1, len(matte_frames))
    needs_choice: list[dict[str, str]] = []
    if foreground_confidence >= 0.5:
        owner_id = "foreground-subject"
        asset_id = "asset-foreground-subject"
        owners.append(
            {
                "ownerId": owner_id,
                "kind": "foreground-subject",
                "editable": True,
                "assetRef": asset_id,
                "confidence": foreground_confidence,
            }
        )
        assets.append(
            {
                "assetId": asset_id,
                "kind": "measured-matte",
                "editable": True,
                "owner": owner_id,
            }
        )
        geometry[owner_id] = {
            "boundsPerFrame": [map_bounds(sample) for sample in foreground_samples],
            "fixedWidth": False,
            "fixedX": False,
        }
        tracks.append(
            {
                "trackId": "track-foreground-subject",
                "owner": owner_id,
                "lifecycle": lifecycle(foreground_samples, frame_count),
                "geometryRef": owner_id,
                "effects": [],
            }
        )
    elif any(matte["coverage"] > 0 for matte in matte_frames):
        needs_choice.append(
            {
                "state": "NEEDS_CHOICE",
                "choiceId": "choice_foreground_subject_ownership",
                "reason": "ambiguous-matte-evidence",
            }
        )
    overlap_choice = depth_overlap_choice(
        [
            *[(f"text-{index:02d}", samples) for index, samples in enumerate(text_tracks)],
            *[
                (f"ui-surface-{index:02d}", samples)
                for index, samples in enumerate(surface_tracks)
            ],
        ]
    )
    if not needs_choice and overlap_choice is not None:
        needs_choice.append(overlap_choice)
    for index, samples in enumerate(text_tracks):
        owner_id = f"text-{index:02d}"
        asset_id = f"asset-{owner_id}"
        text_ids.append(owner_id)
        representative = representative_text(samples)
        owners.append(
            {
                "ownerId": owner_id,
                "kind": (
                    "subtitle"
                    if float(representative["bounds"][1])
                    + float(representative["bounds"][3]) / 2
                    > float(representative["canvasHeight"]) * 0.7
                    else "text-word"
                ),
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
                "formula": "fraction(luma > 0.88)",
                "confidence": min(effect_confidence(sample) for sample in samples),
                "samples": effect_samples(samples, "bloom"),
            },
            "defocus": {
                "source": "native owner Laplacian profile",
                "formula": "1/sqrt(var(laplacian))",
                "confidence": min(effect_confidence(sample) for sample in samples),
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
                "kind": "ui-surface",
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
                "formula": "mean(canny(80,180))/255",
                "confidence": min(effect_confidence(sample) for sample in samples),
                "samples": effect_samples(samples, "rim"),
            },
            "bloom": {
                "source": "native owner luminance profile",
                "formula": "fraction(luma > 0.88)",
                "confidence": min(effect_confidence(sample) for sample in samples),
                "samples": effect_samples(samples, "bloom"),
            },
            "defocus": {
                "source": "native owner Laplacian profile",
                "formula": "1/sqrt(var(laplacian))",
                "confidence": min(effect_confidence(sample) for sample in samples),
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
    if foreground_confidence >= 0.5:
        passes.append(
            {
                "passId": "foreground-subject-dom",
                "owner": "foreground-subject",
                "kind": "DOM/SVG",
                "shader": None,
                "reads": ["measured matte bounds"],
                "writes": "semantic-ui-layer",
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
        "needsChoice": needs_choice,
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
) -> tuple[dict[str, Any], list[dict[str, float | str]]]:
    stages: list[dict[str, float | str]] = []
    progress("models", 0.02)
    stage_started = time.monotonic()
    models = load_models()
    stages.append(
        {"name": "models", "seconds": time.monotonic() - stage_started}
    )
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
    progress("all-frame-analysis", 0.02)
    stage_started = time.monotonic()
    for index in range(frame_count):
        ok, native = capture.read()
        if not ok:
            capture.release()
            fail("MISSING_TEMPORAL_FRAME")
        analysis = cv2.resize(native, ANALYSIS_SIZE, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(analysis, cv2.COLOR_BGR2GRAY)
        frame_ocr = detect_ocr(models, native, analysis, index)
        frame_surfaces = detect_surfaces(native, index)
        matte, recurrent = matte_measure(models, analysis, recurrent)
        depth_field = depth_measure(models, analysis)
        for candidate in [*frame_ocr, *frame_surfaces]:
            candidate["canvasWidth"] = width
            candidate["canvasHeight"] = height
            candidate["ownerEffects"] = owner_effect_measure(
                native, candidate["bounds"]
            )
            candidate["depth"] = region_median(
                depth_field, candidate["bounds"], width, height
            )
        ocr.extend(frame_ocr)
        surfaces.extend(frame_surfaces)
        camera.append(camera_measure(previous_gray, gray, matte["bounds"], fps))
        mattes.append(
            {
                "frame": index,
                **matte,
                "depth": region_median(
                    depth_field,
                    matte["bounds"],
                    ANALYSIS_SIZE[0],
                    ANALYSIS_SIZE[1],
                ),
            }
        )
        depths.append(None if depth_field is None else float(np.median(depth_field)))
        visual.append(visual_measure(analysis))
        frames.append(
            {
                "index": index,
                "timeMs": int(index * 1_000 / fps),
                "nativeSha256": hashlib.sha256(native.tobytes()).hexdigest(),
                "confidence": 1.0,
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
    stages.append(
        {"name": "all-frame-analysis", "seconds": time.monotonic() - stage_started}
    )
    progress("audio-and-mapping", 0.92)
    stage_started = time.monotonic()
    audio = analyze_audio(
        artifact, Path(request["artifactPath"]).parent, fps, frame_count
    )
    colors = derive_palette(visual)
    text_tracks = [interpolate_track(track, fps) for track in track_text(ocr)]
    surface_tracks = [interpolate_track(track, fps) for track in track_surfaces(surfaces)]
    scene = scene_input(
        request,
        frame_count,
        fps,
        text_tracks,
        surface_tracks,
        audio,
        colors,
        mattes,
    )
    bundle = {
        "schemaVersion": "rvs-reference-evidence-v1",
        "state": "NEEDS_CHOICE" if scene["needsChoice"] else "MAPPED",
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
                "ownerSamples": [
                    *[
                        tracking_measurements(f"text-{index:02d}", samples, fps)
                        for index, samples in enumerate(text_tracks)
                    ],
                    *[
                        tracking_measurements(
                            f"ui-surface-{index:02d}", samples, fps
                        )
                        for index, samples in enumerate(surface_tracks)
                    ],
                ],
            },
            "camera": {
                "method": "foreground-masked RANSAC background homography",
                "units": {
                    "translation": "px/ms",
                    "rotation": "deg/ms",
                    "scale": "scale/ms",
                },
                "collisionThreshold": {
                    "translationPxPerMs": 0.002,
                    "rotationDegPerMs": 0.0005,
                    "scalePerMs": 0.00001,
                },
                "frames": camera,
            },
            "tracking": [
                *[
                    tracking_measurements(f"text-{index:02d}", samples, fps)
                    for index, samples in enumerate(text_tracks)
                ],
                *[
                    tracking_measurements(f"ui-surface-{index:02d}", samples, fps)
                    for index, samples in enumerate(surface_tracks)
                ],
            ],
            "effects": visual,
            "rhythm": rhythm_measurements(visual, audio, fps),
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
        "needsChoice": scene["needsChoice"],
        "sceneInput": scene,
    }
    stages.append(
        {"name": "audio-and-mapping", "seconds": time.monotonic() - stage_started}
    )
    return bundle, stages


def main() -> int:
    if len(sys.argv) != 3:
        return 2
    started = time.monotonic()
    try:
        request = json.loads(Path(sys.argv[1]).read_text())
        artifact, frame_count, fps = verify_request(request)
        verify_models()
        progress("preflight", 0.01)
        preflight_seconds = time.monotonic() - started
        bundle, stages = compile_bundle(request, artifact, frame_count, fps)
        progress("evidence", 1.0)
        output = {
            "protocol": "rvs.compiler.v1",
            "kind": "evidence",
            "bundle": bundle,
            "stages": [
                {"name": "preflight", "seconds": preflight_seconds}, *stages
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
