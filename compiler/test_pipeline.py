from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from compiler.pipeline import (
    classify_locale,
    compile_bundle,
    content_window,
    map_bounds,
    scene_input,
    track_surfaces,
    track_text,
)


def candidate(frame: int, text: str, x: int, confidence: float = 0.8) -> dict:
    return {
        "frame": frame,
        "text": text,
        "confidence": confidence,
        "bounds": [x, 100, 180, 48],
    }


class FakeCapture:
    def __init__(self, frames: list[np.ndarray]) -> None:
        self.frames = frames
        self.index = 0

    def get(self, property_id: int) -> float:
        import cv2

        if property_id == cv2.CAP_PROP_FRAME_WIDTH:
            return float(self.frames[0].shape[1])
        if property_id == cv2.CAP_PROP_FRAME_HEIGHT:
            return float(self.frames[0].shape[0])
        return 0.0

    def isOpened(self) -> bool:  # noqa: N802 - mirrors the cv2 API
        return True

    def set(self, property_id: int, value: float) -> bool:
        import cv2

        # content_window seeks while sampling for letterbox bars; rewinding
        # here keeps the subsequent full read starting from frame 0.
        if property_id == cv2.CAP_PROP_POS_FRAMES:
            self.index = int(value)
        return True

    def read(self) -> tuple[bool, np.ndarray | None]:
        if self.index >= len(self.frames):
            return False, None
        frame = self.frames[self.index]
        self.index += 1
        return True, frame

    def release(self) -> None:
        self.index = 0


class TrackTextTest(unittest.TestCase):
    def test_compile_bundle_camera_frames_include_frame_index(self) -> None:
        frames = [
            np.full((96, 54, 3), index * 16, dtype=np.uint8) for index in range(2)
        ]
        with TemporaryDirectory() as directory:
            artifact = Path(directory) / "normalized.mkv"
            artifact.write_bytes(b"normalized")
            with (
                mock.patch("compiler.pipeline.load_models", return_value={}),
                mock.patch(
                    "compiler.pipeline.cv2.VideoCapture",
                    return_value=FakeCapture(frames),
                ),
                mock.patch("compiler.pipeline.analyze_audio", return_value=[]),
            ):
                bundle, _stages = compile_bundle(
                    {
                        "tenantId": "ten_a",
                        "jobId": "job-a",
                        "attemptId": "attempt-a",
                        "artifactPath": str(artifact),
                    },
                    artifact,
                    len(frames),
                    30,
                )

        self.assertEqual(
            [0, 1],
            [frame["frame"] for frame in bundle["observed"]["camera"]["frames"]],
        )

    def test_merges_ocr_variants_without_merging_distinct_owners(self) -> None:
        tracks = track_text(
            [
                candidate(0, "' YouMotion", 100),
                candidate(1, "1 YouMotion", 102),
                candidate(2, "YouMotion", 800),
                candidate(3, "~YouMotion", 802),
                candidate(4, "A Cool Template", 100),
                candidate(5, "ACool Template", 101),
                candidate(6, "A Coo", 102, 0.95),
                candidate(7, "noise", 500),
            ]
        )

        self.assertEqual(3, len(tracks))
        self.assertEqual([2, 2, 3], sorted(map(len, tracks)))

    def test_tracks_moving_surfaces_without_merging_shape_changes(self) -> None:
        tracks = track_surfaces(
            [
                {"frame": 0, "bounds": [100, 100, 400, 700]},
                {"frame": 1, "bounds": [102, 104, 405, 696]},
                {"frame": 2, "bounds": [105, 110, 410, 690]},
                {"frame": 10, "bounds": [150, 300, 300, 80]},
                {"frame": 11, "bounds": [154, 302, 300, 80]},
                {"frame": 12, "bounds": [158, 305, 300, 80]},
            ]
        )

        self.assertEqual([3, 3], sorted(map(len, tracks)))

    def test_scene_maps_measured_owners_to_all_runtime_passes(self) -> None:
        def owner(frame: int, text: str) -> dict:
            return {
                "frame": frame,
                "text": text,
                "confidence": 0.9,
                "bounds": [100 + frame, 200, 400, 80],
                "canvasWidth": 1080,
                "canvasHeight": 1920,
                "ownerEffects": {"bloom": 0.2, "defocus": 0.3, "rim": 0.4},
            }

        scene = scene_input(
            {"tenantId": "ten_a"},
            120,
            30,
            [[owner(0, "Title"), owner(119, "Title")]],
            [[owner(0, ""), owner(119, "")]],
            [],
            ["#101820", "#f0f8ff"],
        )
        shaders = {
            render_pass["shader"]
            for render_pass in scene["passes"]
            if render_pass["shader"] is not None
        }
        self.assertEqual(set(scene["allowedShaders"]), shaders)
        self.assertEqual(
            ["lower-light-behind-ui", "lower-light-over-ui"],
            [
                render_pass["passId"]
                for render_pass in scene["passes"]
                if render_pass["shader"] == "lower-light-field-13tap"
            ],
        )
        self.assertEqual(
            [0, 119],
            [
                sample["frame"]
                for sample in scene["effects"]["text-00"]["bloom"]["samples"]
            ],
        )

    def test_uniform_fit_maps_landscape_geometry_without_stretching(self) -> None:
        self.assertEqual(
            {"frame": 0, "x": 0, "y": 664, "width": 1080, "height": 592},
            map_bounds(
                {
                    "frame": 0,
                    "bounds": [0, 0, 1588, 870],
                    "canvasWidth": 1588,
                    "canvasHeight": 870,
                }
            ),
        )

    def test_content_window_crops_pillarbox_and_ignores_bar_watermark(self) -> None:
        # A 9:16 clip exported inside a 16:9 canvas, with a static watermark
        # burned into the right bar -- the shape that made the compiler
        # analyse mostly padding and adopt the watermark as an owner.
        frames = []
        for index in range(8):
            frame = np.zeros((870, 1588, 3), dtype=np.uint8)
            frame[:, 532:1048] = 40 + index * 8
            frame[40:80, 1200:1500] = 90
            frames.append(frame)
        with TemporaryDirectory() as directory:
            artifact = Path(directory) / "normalized.mkv"
            artifact.write_bytes(b"normalized")
            with mock.patch(
                "compiler.pipeline.cv2.VideoCapture",
                return_value=FakeCapture(frames),
            ):
                window = content_window(artifact, len(frames))
        self.assertEqual((532, 0, 516, 870), window)

    def test_compile_bundle_analyses_the_cropped_frame(self) -> None:
        frames = []
        for index in range(4):
            frame = np.zeros((870, 1588, 3), dtype=np.uint8)
            frame[:, 532:1048] = 40 + index * 8
            frames.append(frame)
        seen: list[tuple[int, int]] = []

        def record(frame: np.ndarray, index: int) -> list[dict]:
            seen.append((frame.shape[1], frame.shape[0]))
            return []

        with TemporaryDirectory() as directory:
            artifact = Path(directory) / "normalized.mkv"
            artifact.write_bytes(b"normalized")
            with (
                mock.patch("compiler.pipeline.load_models", return_value={}),
                mock.patch(
                    "compiler.pipeline.cv2.VideoCapture",
                    return_value=FakeCapture(frames),
                ),
                mock.patch("compiler.pipeline.analyze_audio", return_value=[]),
                mock.patch("compiler.pipeline.detect_surfaces", side_effect=record),
            ):
                compile_bundle(
                    {
                        "tenantId": "ten_a",
                        "jobId": "job-a",
                        "attemptId": "attempt-a",
                        "artifactPath": str(artifact),
                    },
                    artifact,
                    len(frames),
                    30,
                )
        # Not (1588, 870): the bars must be gone before anything measures.
        self.assertEqual([(516, 870)] * len(frames), seen)

    def test_content_window_keeps_the_frame_when_there_are_no_bars(self) -> None:
        frames = [np.full((96, 54, 3), 120, dtype=np.uint8) for _ in range(4)]
        with TemporaryDirectory() as directory:
            artifact = Path(directory) / "normalized.mkv"
            artifact.write_bytes(b"normalized")
            with mock.patch(
                "compiler.pipeline.cv2.VideoCapture",
                return_value=FakeCapture(frames),
            ):
                self.assertEqual(
                    (0, 0, 54, 96), content_window(artifact, len(frames))
                )

    def test_cropped_pillarbox_fills_the_render_canvas(self) -> None:
        # Before the crop this mapped to 1080x592 in a 1080x1920 canvas --
        # 69% of the output was guaranteed to be black bars.
        mapped = map_bounds(
            {
                "frame": 0,
                "bounds": [0, 0, 516, 870],
                "canvasWidth": 516,
                "canvasHeight": 870,
            }
        )
        self.assertEqual(1080, mapped["width"])
        self.assertGreater(mapped["height"], 1800)

    def test_scene_emits_foreground_owner_from_confident_matte_evidence(self) -> None:
        mattes = [
            {"frame": frame, "coverage": 0.2, "bounds": [100, 100, 200, 400]}
            for frame in range(4)
        ]
        scene = scene_input(
            {"tenantId": "ten_a"}, 4, 30, [], [], [], ["#101820"], mattes
        )

        self.assertIn(
            "foreground-subject", [owner["ownerId"] for owner in scene["owners"]]
        )
        self.assertEqual([], scene["needsChoice"])

    def test_scene_propagates_ambiguous_matte_ownership_as_needs_choice(self) -> None:
        scene = scene_input(
            {"tenantId": "ten_a"},
            4,
            30,
            [],
            [],
            [],
            ["#101820"],
            [{"frame": 0, "coverage": 0.01, "bounds": [1, 1, 2, 2]}],
        )

        self.assertEqual("NEEDS_CHOICE", scene["needsChoice"][0]["state"])

    def test_scene_tags_text_owner_source_locale(self) -> None:
        def owner(frame: int, text: str) -> dict:
            return {
                "frame": frame,
                "text": text,
                "confidence": 0.9,
                "bounds": [100 + frame, 200, 400, 80],
                "canvasWidth": 1080,
                "canvasHeight": 1920,
                "ownerEffects": {"bloom": 0.2, "defocus": 0.3, "rim": 0.4},
            }

        scene = scene_input(
            {"tenantId": "ten_a"},
            120,
            30,
            [[owner(0, "안녕하세요"), owner(119, "안녕하세요")]],
            [],
            [],
            ["#101820"],
        )

        self.assertEqual("ko-KR", scene["owners"][1]["sourceLocale"])


class ClassifyLocaleTest(unittest.TestCase):
    def test_classifies_hangul_majority_text_as_ko_kr(self) -> None:
        self.assertEqual("ko-KR", classify_locale("안녕하세요"))

    def test_classifies_latin_majority_text_as_en_us(self) -> None:
        self.assertEqual("en-US", classify_locale("hello world"))

    def test_classifies_empty_or_symbol_only_text_as_en_us(self) -> None:
        self.assertEqual("en-US", classify_locale("123!!"))


if __name__ == "__main__":
    unittest.main()


def word(frame: int, text: str, box: list[int], confidence: float = 0.9) -> dict:
    return {
        "frame": frame,
        "text": text,
        "confidence": confidence,
        "bounds": box,
    }


class TextTrackReadingTest(unittest.TestCase):
    """Guards the two defects that made the preview paint "AAny NNeeed"."""

    ANY = [142, 413, 114, 71]
    RIGHT = [250, 426, 123, 45]
    WHOLE_LINE = [147, 420, 225, 58]

    def line_read_both_ways(self) -> list[dict]:
        # What EasyOCR actually returned for the reference clip: the line read
        # word by word on most frames, whole on a few, and the right-hand word
        # swapping from "case" to "Need" partway through.
        out: list[dict] = []
        for frame in range(0, 43):
            out.append(word(frame, "Any", self.ANY))
            out.append(word(frame, "case", self.RIGHT))
        for frame in range(45, 75):
            out.append(word(frame, "Any", self.ANY))
            out.append(word(frame, "Need", [248, 437, 127, 51]))
        for frame in (11, 20, 33):
            out.append(word(frame, "Any case", self.WHOLE_LINE, 0.99))
        for frame in (46, 55, 61):
            out.append(word(frame, "Any Need", self.WHOLE_LINE, 0.99))
        return out

    def test_a_whole_line_reading_never_speaks_for_a_single_word(self) -> None:
        from compiler.pipeline import representative_text

        tracks = track_text(self.line_read_both_ways())
        texts = [representative_text(track)["text"] for track in tracks]
        self.assertNotIn("Any case", texts)
        self.assertNotIn("Any Need", texts)
        self.assertEqual(sorted(texts), ["Any", "Need", "case"])

    def test_a_word_that_replaces_another_in_place_survives(self) -> None:
        from compiler.pipeline import representative_text

        tracks = track_text(self.line_read_both_ways())
        by_text = {representative_text(track)["text"]: track for track in tracks}
        # "case" and "Need" occupy the same pixels at different times; dropping
        # either as a duplicate loses half the caption.
        self.assertLess(max(s["frame"] for s in by_text["case"]), 45)
        self.assertGreaterEqual(min(s["frame"] for s in by_text["Need"]), 45)

    def test_two_readings_of_the_same_frames_collapse_to_one(self) -> None:
        from compiler.pipeline import representative_text

        doubled = [word(frame, "Any", self.ANY) for frame in range(0, 40)]
        doubled += [word(frame, "Anv", [145, 415, 112, 70]) for frame in range(0, 40)]
        tracks = track_text(doubled)
        self.assertEqual(
            [representative_text(track)["text"] for track in tracks], ["Any"]
        )


def card_scene(width: int, height: int, count: int, cell: int, columns: int):
    """A dark frame holding `count` glowing cards of `cell` px, drawn the same
    way whatever the frame's shape -- so the only thing that varies between two
    calls is what is being tested."""
    import cv2

    image = np.full((height, width, 3), 8, np.uint8)
    for index in range(count):
        x = 60 + (index % columns) * (cell + 30)
        y = 80 + (index // columns) * (cell + 30)
        cv2.rectangle(image, (x, y), (x + cell, y + cell), (180, 120, 60), -1)
        cv2.rectangle(image, (x, y), (x + cell, y + cell), (255, 220, 180), 3)
        cv2.circle(image, (x + cell // 2, y + cell // 2), cell // 5, (250, 250, 250), -1)
    return image


class SurfaceDetectionTest(unittest.TestCase):
    def test_the_same_cards_are_found_whichever_way_the_frame_turns(self) -> None:
        from compiler.pipeline import detect_surfaces

        # Identical cards, identical pixel count, opposite orientation. Sizing
        # the gate off the frame's width made the landscape frame demand a card
        # two thirds wider than the portrait one, and it found none at all.
        for cell in (150, 100):
            portrait = detect_surfaces(card_scene(516, 870, 4, cell, 2), 0)
            landscape = detect_surfaces(card_scene(870, 516, 4, cell, 2), 0)
            self.assertEqual(
                len(portrait), len(landscape), f"{cell}px cards differ by orientation"
            )
            self.assertEqual(len(portrait), 4)

    def test_a_glow_inside_a_card_is_not_a_second_card(self) -> None:
        import cv2

        from compiler.pipeline import detect_surfaces

        # One card with a large bright core: the outline and the core are
        # nested, so their IoU is far below the duplicate threshold and an IoU
        # test alone reports two surfaces where a viewer sees one.
        image = np.full((870, 516, 3), 8, np.uint8)
        cv2.rectangle(image, (60, 80), (460, 480), (180, 120, 60), -1)
        cv2.rectangle(image, (60, 80), (460, 480), (255, 220, 180), 3)
        cv2.rectangle(image, (110, 130), (410, 430), (250, 250, 250), -1)
        self.assertEqual(len(detect_surfaces(image, 0)), 1)


class SurfaceTrackingTest(unittest.TestCase):
    """A surface that moves is still one surface."""

    @staticmethod
    def sweeping(speed: int, count: int = 3, cell: int = 150, frames: int = 60):
        import cv2

        travel = 516 - cell - 80
        clip = []
        for frame in range(frames):
            image = np.full((870, 516, 3), 8, np.uint8)
            walked = (speed * frame) % (2 * travel)
            x = 40 + (walked if walked <= travel else 2 * travel - walked)
            for index in range(count):
                y = 90 + index * (cell + 40)
                cv2.rectangle(image, (x, y), (x + cell, y + cell), (180, 120, 60), -1)
                cv2.rectangle(image, (x, y), (x + cell, y + cell), (255, 220, 180), 3)
                cv2.circle(
                    image, (x + cell // 2, y + cell // 2), cell // 5, (250, 250, 250), -1
                )
            clip.append(image)
        return clip

    def tracks_for(self, clip):
        from compiler.pipeline import detect_surfaces

        found = []
        for index, frame in enumerate(clip):
            found.extend(detect_surfaces(frame, index))
        return track_surfaces(found)

    def test_speed_does_not_split_a_surface_into_several_owners(self) -> None:
        # Comparing a detection with the track's last observed box made this
        # speed-dependent: past roughly the card's own width per frame the two
        # boxes stopped touching and one card became two owners.
        for speed in (2, 25, 100, 150):
            tracks = self.tracks_for(self.sweeping(speed))
            self.assertEqual(len(tracks), 3, f"{speed} px/frame split the cards")
            for track in tracks:
                span = max(s["frame"] for s in track) - min(s["frame"] for s in track)
                self.assertEqual(span + 1, 60, f"{speed} px/frame broke a track")

    def test_a_frame_holding_nine_surfaces_yields_nine_owners(self) -> None:
        import cv2

        clip = []
        for frame in range(60):
            image = np.full((870, 516, 3), 8, np.uint8)
            for index in range(9):
                x = 50 + (index % 3) * 165 + int(3 * np.sin(frame / 9 + index))
                y = 70 + (index // 3) * 165 + int(3 * np.cos(frame / 11 + index))
                cv2.rectangle(image, (x, y), (x + 140, y + 140), (180, 120, 60), -1)
                cv2.rectangle(image, (x, y), (x + 140, y + 140), (255, 220, 180), 3)
                cv2.circle(image, (x + 70, y + 70), 28, (250, 250, 250), -1)
            clip.append(image)
        self.assertEqual(len(self.tracks_for(clip)), 9)


class SegmentedSurfaceTest(unittest.TestCase):
    """The segmentation path, with the model stood in for."""

    class Segmenter:
        """Returns what MobileSAM returns for a card holding a glyph: the card,
        the glyph nested inside it, and a neighbouring card."""

        def __init__(self, boxes):
            self.boxes = boxes
            self.calls = 0

        def generate(self, image):
            self.calls += 1
            return [
                {"bbox": box, "area": box[2] * box[3], "predicted_iou": 0.94}
                for box in self.boxes
            ]

    def models_with(self, boxes):
        return {"segmenter": self.Segmenter(boxes)}

    def test_a_glyph_inside_a_card_does_not_become_a_second_surface(self) -> None:
        from compiler.pipeline import segment_surfaces

        # In the 480-tall frame the segmenter sees: a card, its glyph, another
        # card. Only the two cards are surfaces.
        models = self.models_with(
            [[20, 30, 120, 130], [50, 60, 60, 70], [160, 30, 120, 130]]
        )
        frame = np.zeros((960, 540, 3), np.uint8)
        found = segment_surfaces(models, frame, 0)
        self.assertEqual(len(found), 2)

    def test_boxes_come_back_in_the_frame_s_own_pixels(self) -> None:
        from compiler.pipeline import segment_surfaces

        # The segmenter sees a half-height copy, so a box at 20,30 sized
        # 120x130 there is at 40,60 sized 240x260 in the frame itself.
        models = self.models_with([[20, 30, 120, 130]])
        frame = np.zeros((960, 540, 3), np.uint8)
        self.assertEqual(segment_surfaces(models, frame, 7)[0]["bounds"], [40, 60, 240, 260])
        self.assertEqual(segment_surfaces(models, frame, 7)[0]["frame"], 7)

    def test_keyframes_are_within_the_gap_the_tracker_bridges(self) -> None:
        from compiler.pipeline import SEGMENTER_STRIDE, SURFACE_TRACK_GAP

        # Frames between keyframes contribute nothing, so a stride wider than
        # the tracker's reach would break every track. Half of it leaves room
        # for one missed keyframe.
        self.assertLessEqual(SEGMENTER_STRIDE * 2, SURFACE_TRACK_GAP)

    def test_a_surface_seen_only_on_keyframes_is_still_tracked_throughout(self) -> None:
        from compiler.pipeline import SEGMENTER_STRIDE, interpolate_track

        # One card drifting, sampled only every SEGMENTER_STRIDE frames.
        samples = [
            {
                "frame": f,
                "bounds": [100 + f, 200 + f, 150, 150],
                "confidence": 0.9,
                "ownerEffects": {
                    "bloom": 0.1,
                    "defocus": 0.1,
                    "rim": 0.1,
                    "confidence": 1.0,
                },
            }
            for f in range(0, 120, SEGMENTER_STRIDE)
        ]
        tracks = track_surfaces(samples)
        self.assertEqual(len(tracks), 1)
        filled = interpolate_track(tracks[0], 30)
        self.assertEqual(
            [s["frame"] for s in filled], list(range(0, samples[-1]["frame"] + 1))
        )
