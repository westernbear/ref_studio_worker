from __future__ import annotations

import collections
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
from scipy.optimize import linear_sum_assignment

ADMITTED_FPS = {24, 25, 30, 50, 60}
ANALYSIS_SIZE = (540, 960)
MAX_FRAMES = 240
# Letterbox/pillarbox detection. A bar is a band of rows or columns that stays
# near-black for the whole clip; measuring the mean (not the peak) keeps a
# static watermark burned into the bar from being mistaken for content.
BAR_SAMPLE_FRAMES = 24
BAR_LEVEL = 0.08
BAR_MIN_EXTENT = 0.30


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
        sys.path.insert(0, str(vendor / "mobilesam"))
        from mobile_sam import SamAutomaticMaskGenerator, sam_model_registry

        sam = sam_model_registry["vit_t"](checkpoint=str(model_dir / "mobile_sam.pt"))
        sam.eval()
        segmenter = SamAutomaticMaskGenerator(
            sam, points_per_side=SEGMENTER_POINTS_PER_SIDE
        )
    return {
        "torch": torch,
        "rvm": rvm,
        "midas": midas,
        "ocr": ocr,
        "segmenter": segmenter,
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


def _longest_lit_run(profile: np.ndarray) -> tuple[int, int]:
    """Widest contiguous band of the profile that carries light."""
    peak = float(profile.max())
    if peak <= 0:
        return 0, len(profile) - 1
    lit = profile > peak * BAR_LEVEL
    best = (0, len(profile) - 1)
    best_len = -1
    start: int | None = None
    for i, on in enumerate([*lit, False]):
        if on and start is None:
            start = i
        elif not on and start is not None:
            if i - start > best_len:
                best_len, best = i - start, (start, i - 1)
            start = None
    return best


def content_window(artifact: Path, frame_count: int) -> tuple[int, int, int, int]:
    """Crop rectangle (x, y, width, height) excluding letterbox/pillarbox bars.

    Sources exported as, say, a 9:16 clip inside a 16:9 canvas otherwise get
    analysed mostly on padding: the bars drag every measurement toward black,
    swallow the size gates in detect_surfaces, and -- once map_bounds fits the
    padded frame into the render canvas -- leave the reconstruction confined to
    a small band. Anything burned into the bars (a watermark) is not part of
    the reference either, so it must not become an owner.
    """
    capture = cv2.VideoCapture(str(artifact))
    if not capture.isOpened():
        fail("NORMALIZED_ARTIFACT_CORRUPT")
    width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, frame_count // BAR_SAMPLE_FRAMES)
    total = np.zeros((height, width), dtype=np.float64)
    sampled = 0
    for index in range(0, frame_count, step):
        capture.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = capture.read()
        if not ok:
            continue
        total += cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        sampled += 1
    capture.release()
    if sampled == 0:
        return 0, 0, width, height
    mean = total / sampled
    x0, x1 = _longest_lit_run(mean.mean(axis=0))
    y0, y1 = _longest_lit_run(mean.mean(axis=1))
    crop_width, crop_height = x1 - x0 + 1, y1 - y0 + 1
    # A crop this aggressive means the measurement was wrong, not that the
    # source is mostly padding -- keep the full frame instead.
    if crop_width < width * BAR_MIN_EXTENT or crop_height < height * BAR_MIN_EXTENT:
        return 0, 0, width, height
    return x0, y0, crop_width, crop_height


# An icon's outline and the glow inside it are nested, not adjacent: their IoU
# is low, so an IoU test lets both through and both become owners painted on
# the same icon. Containment catches what IoU cannot.
SURFACE_CONTAINMENT_LIMIT = 0.7
# How many surfaces a frame holds is a property of the frame, so these do not
# decide it. They were four and six, which on a scene of nine cards returned
# four; the size gates and the containment rule choose what is a surface, and
# on that scene the choosing alone now returns all nine, each tracked end to
# end. They could not be lifted before the tracker was fixed -- lifting them
# turned six tracks into thirty-nine, because the same icon kept being
# re-acquired as a new owner -- and with association repaired that same clip
# settles at thirteen. Nothing downstream bounds owner count, so these are only
# a stop against a pathological source, set far above any plausible interface.
SURFACES_PER_FRAME = 64
SURFACE_TRACKS = 64
# How far a surface may travel between frames and still be the same surface,
# in units of its own size. Not a new figure: the text tracker in this file has
# always admitted a word within 1.25 of its own extent, and a card is no more
# free to jump than a word is.
SURFACE_MATCH_REACH = 1.25
# And how alike it must still look. Also not a new figure: this is the overlap
# the tracker has always demanded, now asked of shape alone so that motion
# stops being able to answer it.
SURFACE_SHAPE_AGREEMENT = 0.25
SURFACE_TRACK_GAP = 12
# Segmentation runs on a fraction of the frames and the tracker carries the
# surfaces across the rest, so the stride can never exceed the gap the tracker
# will bridge. Measured on the production image at four threads: one segmented
# keyframe costs about nine seconds at this grid, so ten of them add a minute
# and a half to a stage that already takes thirteen, while segmenting all one
# hundred and twenty would take an hour against a thirty-minute deadline.
SEGMENTER_POINTS_PER_SIDE = 8
# Half the gap, not all of it, so a surface the segmenter misses on one
# keyframe is still within reach on the next and its track survives.
SEGMENTER_STRIDE = SURFACE_TRACK_GAP // 2
SEGMENTER_INPUT_HEIGHT = 480


def segment_surfaces(
    models: dict[str, Any], frame: np.ndarray, index: int
) -> list[dict[str, Any]]:
    """Find the surfaces in one frame by segmenting it.

    Edges and size gates cannot answer what a surface is on this material.
    Measured on a reference frame holding six icons: contours split a card
    tilted in space into three horizontal bands, because no upright box fits a
    rotated card, and raised a sixth box on a glow highlight the same size as a
    real card -- so no size threshold can separate them. Depth, which this
    pipeline already measures, keeps a tilted card whole and ignores highlights
    entirely, but its card boundaries are ramps rather than steps, and reading
    them back needs a threshold that truncates the cards it does find. Segments
    have no such boundary problem: the same frame yields all six cards whole,
    tilted one included, and the glyphs it also finds inside them are nested,
    which the containment rule already removes.
    """
    height, width = frame.shape[:2]
    scale = SEGMENTER_INPUT_HEIGHT / height
    small = cv2.resize(
        frame,
        (max(1, round(width * scale)), SEGMENTER_INPUT_HEIGHT),
        interpolation=cv2.INTER_AREA,
    )
    masks = models["segmenter"].generate(cv2.cvtColor(small, cv2.COLOR_BGR2RGB))
    found: list[dict[str, Any]] = []
    for mask in sorted(masks, key=lambda item: -item["area"]):
        x, y, mask_width, mask_height = mask["bbox"]
        found.append(
            {
                "frame": index,
                "bounds": [
                    round(x / scale),
                    round(y / scale),
                    round(mask_width / scale),
                    round(mask_height / scale),
                ],
                "confidence": float(np.clip(mask.get("predicted_iou", 0.9), 0, 1)),
            }
        )
    return admit_surfaces(found, width, height)


def admit_surfaces(
    found: list[dict[str, Any]], width: int, height: int
) -> list[dict[str, Any]]:
    """Keep the candidates that are surfaces and drop the ones already counted.

    Both size gates measure against the short side, so the same card has to be
    the same number of pixels to survive whether the frame is portrait or
    landscape. Measuring width against the frame's width made orientation
    decide the answer: rotating a frame of identical content and identical
    pixel count turned four detected cards into none, because a landscape frame
    demanded a card two thirds wider than a portrait one did. The fractions
    themselves are inherited and not independently justified.
    """
    short = min(width, height)
    kept: list[dict[str, Any]] = []
    for candidate in sorted(
        found, key=lambda item: -(item["bounds"][2] * item["bounds"][3])
    ):
        box = candidate["bounds"]
        area = box[2] * box[3]
        if area < width * height * 0.025 or area > width * height * 0.88:
            continue
        if box[2] < short * 0.18 or box[3] < short * 0.06:
            continue
        if any(
            box_iou(box, item["bounds"]) >= 0.72
            or overlap_ratio(box, item["bounds"]) > SURFACE_CONTAINMENT_LIMIT
            for item in kept
        ):
            continue
        kept.append(candidate)
    return kept[:SURFACES_PER_FRAME]


def detect_surfaces(frame: np.ndarray, index: int) -> list[dict[str, Any]]:
    """Find surfaces from edges alone, for when no models are loaded.

    Kept for the smoke path and as the fallback if segmentation is missing; see
    segment_surfaces for what this cannot do on rendered material.
    """
    height, width = frame.shape[:2]
    edges = cv2.Canny(cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY), 60, 160)
    contours, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    found = [
        {
            "frame": index,
            "bounds": list(cv2.boundingRect(contour)),
            "confidence": 0.6,
        }
        for contour in contours
    ]
    return admit_surfaces(found, width, height)


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
    """Low-frequency light field, one RGB triple per 16x9 cell.

    The mean, not the median: a cell is ~1/144 of the frame, so a glow that
    covers part of one is exactly the signal this field exists to carry, and
    the median throws it away by picking the dark majority. The renderer
    writes this straight out as the opaque base layer, so a median here is
    what made the reconstruction of a dark, glow-lit reference come out flat
    black. visual_measure's sibling grid already averages (INTER_AREA).
    """
    height, width = rgb.shape[:2]
    x_edges = np.linspace(0, width, 17, dtype=int)
    y_edges = np.linspace(0, height, 10, dtype=int)
    return [
        float(value) / 255
        for row in range(9)
        for column in range(16)
        for value in np.mean(
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
            "lowerLight": "mean RGB per 16x9 cell",
        },
    }


def owner_appearance(crop: np.ndarray) -> dict[str, Any]:
    """What the owner actually looks like: a dark-to-light colour ramp.

    Without this the IR describes where an owner is and how it glows but never
    what colour it is, so the renderer can only fall back to its stylesheet's
    near-black placeholder fill -- a perfectly located, perfectly invisible
    rectangle.
    """
    rgb = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).reshape(-1, 3).astype(np.float32)
    stops = [np.percentile(rgb, percentile, axis=0) for percentile in (20, 60, 92)]
    return {
        "palette": [
            "#" + "".join(f"{int(np.clip(value, 0, 255)):02x}" for value in stop)
            for stop in stops
        ],
        "meanRgb": [float(value) for value in rgb.mean(axis=0)],
    }


def owner_effect_measure(frame: np.ndarray, box: list[int]) -> dict[str, Any]:
    x, y, width, height = box
    crop = frame[y : y + height, x : x + width]
    if crop.size == 0:
        fail("OWNER_MEASUREMENT_FAILED")
    measured = visual_measure(crop)
    appearance = owner_appearance(crop)
    return {
        "bloom": float(np.clip(measured["bloom"], 0, 1)),
        "defocus": float(np.clip(measured["defocusSigma"], 0, 1)),
        "rim": float(np.clip(measured["rim"], 0, 1)),
        "palette": appearance["palette"],
        "meanRgb": appearance["meanRgb"],
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


def is_hangul(character: str) -> bool:
    # Hangul Syllables, Jamo, Compatibility Jamo, Jamo Extended-A/B.
    code = ord(character)
    return (
        0xAC00 <= code <= 0xD7A3
        or 0x1100 <= code <= 0x11FF
        or 0x3130 <= code <= 0x318F
        or 0xA960 <= code <= 0xA97F
        or 0xD7B0 <= code <= 0xD7FF
    )


def classify_locale(text: str) -> str:
    letters = [character for character in text if character.isalpha()]
    if not letters:
        return "en-US"
    hangul = sum(1 for character in letters if is_hangul(character))
    return "ko-KR" if hangul / len(letters) > 0.5 else "en-US"


def representative_text(samples: list[dict[str, Any]]) -> dict[str, Any]:
    """The reading the track actually makes most of the time.

    Weighting by length alone lets one outlier speak for the whole track: where
    EasyOCR reads a line word by word on most frames and as a single box on a
    few, the long whole-line reading outscores the short word it shares the
    track with, and the owner ends up captioned with text it never shows in
    that position. Majority first keeps the word; length still breaks ties, so
    a complete reading still beats a truncated one.
    """
    counts = collections.Counter(normalized_text(sample["text"]) for sample in samples)
    return max(
        samples,
        key=lambda sample: (
            counts[normalized_text(sample["text"])],
            float(sample["confidence"]) * len(normalized_text(sample["text"])),
            float(sample["confidence"]),
        ),
    )


# Two text tracks in the same place at the same time are one line read twice,
# not two things to draw. Both halves matter: side-by-side words in a line
# share only about 5% of the smaller box, but a caption that swaps mid-clip
# puts the replacement word exactly where the old one was -- same pixels,
# disjoint frames -- and that one is real.
TEXT_OVERLAP_LIMIT = 0.5
TEXT_LIFETIME_OVERLAP_LIMIT = 0.5


def median_bounds(samples: list[dict[str, Any]]) -> list[float]:
    return [
        statistics.median(float(sample["bounds"][axis]) for sample in samples)
        for axis in range(4)
    ]


def overlap_ratio(a: list[float], b: list[float]) -> float:
    """Shared area as a fraction of the smaller box."""
    width = max(0.0, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]))
    height = max(0.0, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
    smaller = min(a[2] * a[3], b[2] * b[3])
    return 0.0 if smaller <= 0 else width * height / smaller


def lifetime_overlap(a: list[dict[str, Any]], b: list[dict[str, Any]]) -> float:
    """Shared frames as a fraction of the shorter track's span."""
    first_a, last_a = min(s["frame"] for s in a), max(s["frame"] for s in a)
    first_b, last_b = min(s["frame"] for s in b), max(s["frame"] for s in b)
    shared = min(last_a, last_b) - max(first_a, first_b) + 1
    shorter = min(last_a - first_a, last_b - first_b) + 1
    return 0.0 if shorter <= 0 else max(0, shared) / shorter


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
    ordered = sorted(
        (group for group in grouped if len({sample["frame"] for sample in group}) >= 2),
        key=lambda group: (
            len(group),
            statistics.median(item["confidence"] for item in group),
        ),
        reverse=True,
    )
    # EasyOCR reads the same line two ways across a clip: word by word on most
    # frames, and as one box on a few. Both readings can survive grouping and
    # each becomes an owner, so the renderer paints the same glyphs twice a few
    # pixels apart. Keep the stronger reading and drop whatever sits on top of
    # it for the same frames; `ordered` already puts the longest-lived, most
    # confident track first.
    kept: list[list[dict[str, Any]]] = []
    for group in ordered:
        box = median_bounds(group)
        if any(
            overlap_ratio(box, median_bounds(other)) > TEXT_OVERLAP_LIMIT
            and lifetime_overlap(group, other) > TEXT_LIFETIME_OVERLAP_LIMIT
            for other in kept
        ):
            continue
        kept.append(group)
        if len(kept) == 20:
            break
    return kept


def shape_agreement(a: list[float], b: list[float]) -> float:
    """How alike two boxes are once their positions are taken away.

    Overlap answers "same place and same shape?" in one number, which is why it
    breaks on a surface that merely moved. Sliding the two boxes onto a common
    centre first leaves the half of the question that motion cannot disturb, so
    a card that crossed the frame still agrees with itself, while a tall card
    and a short bar in the same spot still do not.
    """
    return box_iou(
        [0.0, 0.0, a[2], a[3]],
        [(a[2] - b[2]) / 2, (a[3] - b[3]) / 2, b[2], b[3]],
    )


def centroid_separation(a: list[float], b: list[float]) -> float:
    """How far two boxes' centres are apart, in units of their own size.

    Scale-free on purpose: the same physical drift has to read the same whether
    the surface is a full-width card or a small chip, so nothing here can be
    expressed in bare pixels.
    """
    scale = max(a[2], a[3], b[2], b[3])
    if scale <= 0:
        return float("inf")
    return (
        math.hypot(
            (a[0] + a[2] / 2) - (b[0] + b[2] / 2),
            (a[1] + a[3] / 2) - (b[1] + b[3] / 2),
        )
        / scale
    )


def track_surfaces(
    candidates: list[dict[str, Any]],
) -> list[list[dict[str, Any]]]:
    """Link per-frame detections into one track per surface.

    Two things decide a link, and the frame decides them together.

    What counts as the same surface is centroid continuity measured in units of
    the surface's own size, which is what the reference interpretation contract
    asks association to report and what this file's text tracker already uses.
    Overlap alone cannot express it: two boxes stop touching as soon as a
    surface travels its own width between frames, and then no overlap threshold
    can hold the track together whatever it is set to.

    Which detection gets which track is then one choice over the whole frame
    rather than a race. Taking the largest box first let it claim a track that
    fitted a smaller box better, and the smaller box -- having nothing left to
    join -- opened a second track on a surface that already had one.
    """
    by_frame: dict[int, list[dict[str, Any]]] = collections.defaultdict(list)
    for candidate in candidates:
        by_frame[candidate["frame"]].append(candidate)
    grouped: list[list[dict[str, Any]]] = []
    for frame in sorted(by_frame):
        detections = by_frame[frame]
        open_tracks = [
            group
            for group in grouped
            if 1 <= frame - group[-1]["frame"] <= SURFACE_TRACK_GAP
        ]
        cost = np.full((len(detections), len(open_tracks)), np.inf)
        for row, detection in enumerate(detections):
            for column, group in enumerate(open_tracks):
                previous = group[-1]["bounds"]
                separation = centroid_separation(detection["bounds"], previous)
                if (
                    separation <= SURFACE_MATCH_REACH
                    and shape_agreement(detection["bounds"], previous)
                    >= SURFACE_SHAPE_AGREEMENT
                ):
                    cost[row, column] = separation
        taken: set[int] = set()
        if open_tracks and np.isfinite(cost).any():
            finite = np.where(np.isfinite(cost), cost, SURFACE_MATCH_REACH * 1_000)
            rows, columns = linear_sum_assignment(finite)
            for row, column in zip(rows, columns):
                if np.isfinite(cost[row, column]):
                    open_tracks[column].append(detections[row])
                    taken.add(row)
        for row, detection in enumerate(detections):
            if row not in taken:
                grouped.append([detection])
    return sorted(
        (group for group in grouped if len(group) >= 2),
        key=len,
        reverse=True,
    )[:SURFACE_TRACKS]


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
                    # Everything measured about the owner carries over from the
                    # frame it was measured on; only the numbers above blend.
                    # Rebuilding this dict from the blend alone silently
                    # dropped the colour palette, and once detection moved to
                    # keyframes five samples in six were interpolated, so the
                    # middle frame a track takes its colour from almost never
                    # had one -- four of six surfaces reached the renderer with
                    # no colour at all and were drawn in the fallback grey.
                    **left["ownerEffects"],
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
    def track_appearance(samples: list[dict[str, Any]]) -> dict[str, Any]:
        """Colour for the whole track, taken from its middle frame.

        One representative frame beats averaging across the track: a fade
        would average toward the background and hand the renderer a colour
        the owner never actually is.
        """
        ordered = sorted(samples, key=lambda sample: sample["frame"])
        effects = ordered[len(ordered) // 2]["ownerEffects"]
        palette = effects.get("palette")
        return {"palette": palette} if palette else {}

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
                "sourceLocale": classify_locale(representative["text"]),
            }
        )
        assets.append(
            {
                "assetId": asset_id,
                "kind": "measured-text",
                "editable": True,
                "owner": owner_id,
                **track_appearance(samples),
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
                **track_appearance(samples),
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
    crop_x, crop_y, width, height = content_window(artifact, frame_count)
    progress("all-frame-analysis", 0.02)
    stage_started = time.monotonic()
    for index in range(frame_count):
        ok, decoded_frame = capture.read()
        if not ok:
            capture.release()
            fail("MISSING_TEMPORAL_FRAME")
        # Everything downstream measures and maps against `native`, so the
        # crop has to happen here -- once -- rather than at each consumer.
        native = decoded_frame[crop_y : crop_y + height, crop_x : crop_x + width]
        analysis = cv2.resize(native, ANALYSIS_SIZE, interpolation=cv2.INTER_AREA)
        gray = cv2.cvtColor(analysis, cv2.COLOR_BGR2GRAY)
        frame_ocr = detect_ocr(models, native, analysis, index)
        # Segmentation answers what a surface is; the tracker carries the answer
        # across the frames in between, and interpolate_track fills a sample
        # into every one of them. Frames that are not keyframes contribute no
        # surface candidates at all, which is why the stride has to stay within
        # what the tracker will bridge.
        if models.get("segmenter") is None:
            frame_surfaces = detect_surfaces(native, index)
        elif index % SEGMENTER_STRIDE == 0:
            frame_surfaces = segment_surfaces(models, native, index)
        else:
            frame_surfaces = []
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
        camera.append(
            {"frame": index, **camera_measure(previous_gray, gray, matte["bounds"], fps)}
        )
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
    tracking = [
        *[
            tracking_measurements(f"text-{index:02d}", samples, fps)
            for index, samples in enumerate(text_tracks)
        ],
        *[
            tracking_measurements(f"ui-surface-{index:02d}", samples, fps)
            for index, samples in enumerate(surface_tracks)
        ],
    ]
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
            # Where the analysed content sits inside the normalized frame.
            # Every geometry in sceneInput is expressed in render-canvas
            # coordinates derived from this window, so anything that draws
            # those geometries back onto the reference video -- the evidence
            # overlay -- needs the window to invert the mapping.
            "contentWindow": {
                "x": crop_x,
                "y": crop_y,
                "width": width,
                "height": height,
            },
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
                "ownerSamples": tracking,
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
            "tracking": tracking,
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
