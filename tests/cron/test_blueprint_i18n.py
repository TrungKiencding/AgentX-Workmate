"""Translated automation blueprints (cron/blueprint_i18n.py).

The Vietnamese "Lịch tự động" dialog listed every template in English and
created jobs with English names and prompts (pilot feedback 2026-11-10). These
tests hold the translation table to the catalog so a new blueprint, slot or
option cannot ship half-translated.
"""

from __future__ import annotations

import re

import pytest

from cron.blueprint_catalog import (
    CATALOG,
    blueprint_catalog_entry,
    blueprint_form_schema,
    fill_blueprint,
    get_blueprint,
)
from cron.blueprint_i18n import TRANSLATIONS, blueprint_text, normalize_locale, slot_text

_PLACEHOLDER = re.compile(r"\{(\w+)\}")
# Latin letters with no Vietnamese diacritics on either side: an English word.
_NUMERIC = re.compile(r"^\d+$")

LOCALES = sorted(TRANSLATIONS)


@pytest.mark.parametrize("raw, expected", [
    ("vi", "vi"), ("vi-VN", "vi"), ("VI_vn", "vi"), (" vi ", "vi"),
    ("en", None), ("zh", None), ("", None), (None, None),
])
def test_normalize_locale(raw, expected):
    assert normalize_locale(raw) == expected


@pytest.mark.parametrize("locale", LOCALES)
@pytest.mark.parametrize("blueprint", CATALOG, ids=lambda b: b.key)
class TestEveryBlueprintIsFullyTranslated:
    def test_title_description_and_prompt(self, blueprint, locale):
        text = blueprint_text(blueprint.key, locale)
        for part in ("title", "description", "prompt"):
            assert text.get(part), f"{blueprint.key}: no {locale} {part}"
        assert text["title"] != blueprint.title

    def test_prompt_keeps_the_same_placeholders(self, blueprint, locale):
        translated = set(_PLACEHOLDER.findall(blueprint_text(blueprint.key, locale)["prompt"]))
        assert translated == set(_PLACEHOLDER.findall(blueprint.prompt_template))

    def test_prompt_keeps_the_silent_marker(self, blueprint, locale):
        # The scheduler suppresses delivery on the literal token.
        if "[SILENT]" in blueprint.prompt_template:
            assert "[SILENT]" in blueprint_text(blueprint.key, locale)["prompt"]

    def test_every_slot_has_a_label(self, blueprint, locale):
        for slot in blueprint.slots:
            text = slot_text(blueprint.key, slot.name, locale)
            assert text.get("label"), f"{blueprint.key}.{slot.name}: no {locale} label"
            if slot.help:
                assert text.get("help"), f"{blueprint.key}.{slot.name}: no {locale} help"

    def test_every_text_default_is_translated(self, blueprint, locale):
        for slot in blueprint.slots:
            if slot.type == "text" and slot.default:
                text = slot_text(blueprint.key, slot.name, locale)
                assert text.get("default"), f"{blueprint.key}.{slot.name}: no {locale} default"
                assert text["default"] != slot.default

    def test_every_worded_option_has_a_label(self, blueprint, locale):
        for slot in blueprint.slots:
            if slot.name == "deliver":
                continue  # platform ids; the desktop renders its own picker
            labels = slot_text(blueprint.key, slot.name, locale).get("options", {})
            for option in slot.options:
                if _NUMERIC.match(str(option)) and str(option) not in labels:
                    continue  # a bare count ("5 bullets") needs no words
                assert str(option) in labels, f"{blueprint.key}.{slot.name}: no {locale} label for {option!r}"

    def test_no_translation_for_a_slot_or_option_that_does_not_exist(self, blueprint, locale):
        own = TRANSLATIONS[locale]["blueprints"][blueprint.key].get("slots", {})
        slots = {slot.name: slot for slot in blueprint.slots}
        assert set(own) <= set(slots)
        for name, text in own.items():
            assert set(text.get("options", {})) <= {str(o) for o in slots[name].options}


@pytest.mark.parametrize("locale", LOCALES)
def test_no_translation_for_a_blueprint_that_does_not_exist(locale):
    assert set(TRANSLATIONS[locale]["blueprints"]) == {b.key for b in CATALOG}


class TestFormSchema:
    def test_english_is_unchanged_without_a_locale(self):
        blueprint = get_blueprint("meal-plan")
        schema = blueprint_form_schema(blueprint)
        assert schema["title"] == "Weekly meal plan"
        assert all("optionLabels" not in field for field in schema["fields"])
        assert blueprint_form_schema(blueprint, "en") == schema
        assert blueprint_form_schema(blueprint, "ja") == schema

    def test_vietnamese_schema_translates_text_and_keeps_values(self):
        schema = blueprint_form_schema(get_blueprint("meal-plan"), "vi")
        assert schema["title"] == "Thực đơn hằng tuần"
        diet = next(f for f in schema["fields"] if f["name"] == "diet")
        # Values stay the stable identifiers the form submits…
        assert diet["options"] == ["no restrictions", "vegetarian", "vegan", "high-protein", "low-carb"]
        assert diet["default"] == "no restrictions"
        # …and each one has something to show.
        assert diet["optionLabels"]["vegan"] == "Thuần chay"
        assert set(diet["optionLabels"]) == set(diet["options"])
        day = next(f for f in schema["fields"] if f["name"] == "day")
        assert day["optionLabels"] == {
            "sunday": "Chủ nhật", "monday": "Thứ Hai", "friday": "Thứ Sáu", "saturday": "Thứ Bảy",
        }

    def test_free_text_default_is_translated_but_time_default_is_not(self):
        schema = blueprint_form_schema(get_blueprint("custom-reminder"), "vi")
        fields = {f["name"]: f for f in schema["fields"]}
        assert fields["what"]["default"] == "nghỉ tay và vươn vai một chút"
        assert fields["time"]["default"] == "14:00"
        assert fields["recurrence"]["default"] == "everyday"

    def test_catalog_entry_passes_the_locale_through(self):
        entry = blueprint_catalog_entry(get_blueprint("morning-brief"), "vi")
        assert entry["title"] == "Bản tin buổi sáng"
        # Identifiers are not translated.
        assert entry["command"].startswith("/blueprint morning-brief")
        assert entry["appUrl"].startswith("agentx://blueprint/morning-brief")


class TestFill:
    def test_vietnamese_job_gets_a_vietnamese_name_and_prompt(self):
        spec = fill_blueprint(get_blueprint("morning-brief"), {"time": "07:15"}, locale="vi")
        assert spec["name"] == "Bản tin buổi sáng"
        assert spec["prompt"].startswith("Soạn bản tin buổi sáng")
        assert spec["schedule"] == "15 7 * * *"

    def test_option_values_become_labels_in_the_prompt_only(self):
        spec = fill_blueprint(
            get_blueprint("meal-plan"),
            {"diet": "vegan", "meals": "all three", "effort": "quick", "day": "friday", "time": "17:30"},
            locale="vi",
        )
        assert "Thuần chay" in spec["prompt"]
        assert "Cả ba bữa" in spec["prompt"]
        assert "vegan" not in spec["prompt"]
        # The schedule is still resolved from the raw value.
        assert spec["schedule"] == "30 17 * * 5"

    def test_an_omitted_text_slot_falls_back_to_the_translated_default(self):
        spec = fill_blueprint(get_blueprint("custom-reminder"), {}, locale="vi")
        assert spec["prompt"] == "Nhắc người dùng: nghỉ tay và vươn vai một chút"

    def test_what_the_user_typed_is_kept_verbatim(self):
        spec = fill_blueprint(get_blueprint("custom-reminder"), {"what": "gọi cho mẹ"}, locale="vi")
        assert spec["prompt"] == "Nhắc người dùng: gọi cho mẹ"

    def test_english_fill_is_unchanged(self):
        blueprint = get_blueprint("on-this-day")
        assert fill_blueprint(blueprint, {}) == fill_blueprint(blueprint, {}, locale="en")
        assert "on this day in history" in fill_blueprint(blueprint, {})["prompt"]

    @pytest.mark.parametrize("locale", LOCALES)
    @pytest.mark.parametrize("blueprint", CATALOG, ids=lambda b: b.key)
    def test_every_blueprint_fills_from_defaults_with_nothing_left_unresolved(self, blueprint, locale):
        spec = fill_blueprint(blueprint, {}, locale=locale)
        assert not _PLACEHOLDER.search(spec["prompt"])
        assert spec["name"] == blueprint_text(blueprint.key, locale)["title"]

    def test_validation_still_uses_raw_values(self):
        from cron.blueprint_catalog import BlueprintFillError

        with pytest.raises(BlueprintFillError):
            # A label is not a value: the form must submit "vegan", not its label.
            fill_blueprint(get_blueprint("meal-plan"), {"diet": "Thuần chay"}, locale="vi")
