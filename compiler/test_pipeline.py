from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import numpy as np

from compiler.pipeline import (
    classify_locale,
    compile_bundle,
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

    def read(self) -> tuple[bool, np.ndarray | None]:
        if self.index >= len(self.frames):
            return False, None
        frame = self.frames[self.index]
        self.index += 1
        return True, frame

    def release(self) -> None:
        pass


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
