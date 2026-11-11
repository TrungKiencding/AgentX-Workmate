"""Translations for the automation blueprint catalog.

``cron/blueprint_catalog.py`` is the schema: keys, slot names, option *values*
and schedule templates. Those are identifiers and stay as they are in every
language — ``_resolve_schedule`` matches ``"sunday"`` and ``"weekdays"``
literally. This module holds only what a person reads, per locale:

  * the blueprint's title and description,
  * each slot's label, help text and (for free-text slots) default,
  * a label for each option value,
  * the prompt the scheduled job sends to the model.

The prompt is translated too, not suffixed with "answer in Vietnamese": a job
created from a Vietnamese form shows its prompt in the job's detail pane and
the user edits it there, and a model follows instructions written in the
language it is meant to answer in more reliably than a language switch tacked
on the end. Option values interpolated into a translated prompt are replaced by
their labels, so the sentence stays in one language.

English is the catalog itself and the fallback for every locale without a
table here (pilot feedback 2026-11-10: the Vietnamese "Lịch tự động" dialog
listed all fourteen templates in English).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

__all__ = ["normalize_locale", "blueprint_text", "slot_text", "TRANSLATIONS"]


# Slots that mean the same thing on every blueprint that carries them. A
# blueprint's own ``slots`` entry wins over these.
_VI_SHARED_SLOTS: Dict[str, Dict[str, Any]] = {
    "time": {
        "label": "Vào lúc mấy giờ?",
        "help": "Giờ theo đồng hồ máy bạn, dạng 24 giờ, ví dụ 08:00",
    },
    "deliver": {
        "label": "Gửi kết quả tới đâu?",
        "help": "origin = nơi bạn tạo lịch này (hoặc kênh mặc định đã thiết lập); "
        "local = chỉ lưu trên máy, không gửi tin; hoặc tên một kênh đã kết nối",
    },
    "recurrence": {
        "label": "Lặp lại vào",
        "options": {
            "everyday": "Mọi ngày",
            "weekdays": "Thứ Hai đến Thứ Sáu",
            "weekends": "Thứ Bảy và Chủ nhật",
        },
    },
    "day": {
        "label": "Vào ngày nào?",
        "options": {
            "sunday": "Chủ nhật",
            "monday": "Thứ Hai",
            "tuesday": "Thứ Ba",
            "wednesday": "Thứ Tư",
            "thursday": "Thứ Năm",
            "friday": "Thứ Sáu",
            "saturday": "Thứ Bảy",
        },
    },
}


_VI: Dict[str, Dict[str, Any]] = {
    "morning-brief": {
        "title": "Bản tin buổi sáng",
        "description": "Bản tin ngắn mỗi sáng: lịch hôm nay, thời tiết và những "
        "việc gấp đang chờ bạn.",
        "prompt": (
            "Soạn bản tin buổi sáng ngắn gọn cho người dùng: lịch hôm nay, thời "
            "tiết nơi họ ở và những việc gấp đang chờ. Viết ngắn, dễ lướt. Nếu "
            "chưa kết nối nguồn dữ liệu nào, chỉ cần chào buổi sáng kèm ngày "
            "tháng và gợi ý kết nối lịch hoặc email."
        ),
    },
    "important-mail": {
        "title": "Theo dõi thư quan trọng",
        "description": "Định kỳ kiểm tra hộp thư và CHỈ báo khi có thư thật sự "
        "cần bạn để ý.",
        "prompt": (
            "Kiểm tra hộp thư của người dùng, chỉ xét thư mới kể từ lần chạy "
            "trước. CHỈ báo những thư thoả điều kiện: {criteria}. Đánh giá mức "
            "khẩn cấp của từng thư và chỉ gửi những thư thật sự cần chú ý; nếu "
            "không có thư nào, trả lời đúng [SILENT]. Việc này cần một nguồn thư "
            "đã kết nối; nếu chưa có, hãy hướng dẫn cách kết nối rồi dừng."
        ),
        "slots": {
            "interval_min": {
                "label": "Bao lâu kiểm tra một lần?",
                "help": "Khoảng cách giữa hai lần kiểm tra",
                "options": {"15": "15 phút", "30": "30 phút", "60": "1 giờ"},
            },
            "criteria": {
                "label": "Chỉ báo cho tôi khi thư…",
                "default": "cần trả lời trong hôm nay, đến từ sếp hoặc người thân, "
                "hoặc nhắc tới một hạn chót",
            },
        },
    },
    "weekly-review": {
        "title": "Tổng kết tuần",
        "description": "Nhìn lại một tuần: việc đã xong, việc còn dở và những gì "
        "sắp tới.",
        "prompt": (
            "Soạn bản tổng kết tuần cho người dùng: những việc đã hoàn thành "
            "trong tuần, những việc còn dang dở và lịch tuần tới. Lấy dữ liệu từ "
            "các nguồn đã kết nối. Viết gọn."
        ),
    },
    "workday-start": {
        "title": "Nhắc đầu ngày làm việc",
        "description": "Lời nhắc vào các ngày làm việc, kèm lịch và những việc "
        "ưu tiên.",
        "prompt": (
            "Gửi người dùng một lời nhắc ngắn đầu ngày làm việc: lịch hôm nay và "
            "1–3 việc ưu tiên nhất nên tập trung, suy ra từ ngữ cảnh gần đây và "
            "các công cụ quản lý công việc nếu có. Giọng khích lệ, ngắn gọn, gói "
            "trong một tin nhắn."
        ),
    },
    "custom-reminder": {
        "title": "Lời nhắc tuỳ chỉnh",
        "description": "Lời nhắc lặp lại, viết theo ý bạn, vào giờ bạn chọn.",
        "prompt": "Nhắc người dùng: {what}",
        "slots": {
            "what": {
                "label": "Nhắc tôi…",
                "default": "nghỉ tay và vươn vai một chút",
            },
        },
    },
    "evening-winddown": {
        "title": "Khép lại một ngày",
        "description": "Điểm lại cuối ngày: xem nhanh lịch ngày mai và những gì "
        "nên chuẩn bị từ tối nay.",
        "prompt": (
            "Gửi người dùng một lời nhắn ngắn cuối ngày: lịch ngày mai, những "
            "việc đầu giờ cần chuẩn bị trước, và một lời nhắc nhẹ nhàng để khép "
            "lại những việc còn dở hôm nay. Giọng thư thả, ngắn gọn, gói trong "
            "một tin nhắn. Nếu chưa kết nối lịch, chỉ cần chúc buổi tối tốt lành "
            "kèm dự báo thời tiết ngày mai."
        ),
    },
    "news-digest": {
        "title": "Điểm tin theo chủ đề",
        "description": "Bản tin định kỳ về chủ đề bạn quan tâm, đã lọc trùng với "
        "các lần trước nên chỉ có tin thật sự mới.",
        "prompt": (
            "Tìm trên web những tin mới và đáng chú ý về: {topic}. Đối chiếu với "
            "những gì đã gửi ở các lần chạy trước, chỉ đưa vào diễn biến thật sự "
            "mới. Gửi bản tin gọn, tối đa {count} gạch đầu dòng, mỗi dòng một ý "
            "kèm đường dẫn. Nếu không có gì mới so với lần trước, trả lời đúng "
            "[SILENT]."
        ),
        "slots": {
            "topic": {
                "label": "Chủ đề nào?",
                "help": "Một chủ đề, sản phẩm, nhân vật hoặc cụm từ tìm kiếm",
                "default": "AI và công nghệ",
            },
            "count": {"label": "Tối đa bao nhiêu tin?"},
        },
    },
    "bill-renewal-watch": {
        "title": "Nhắc hoá đơn và gia hạn",
        "description": "Báo trước khi tới kỳ thanh toán, lần gia hạn gói dịch vụ "
        "hay một hạn chót, để không bị trừ tiền bất ngờ.",
        "prompt": (
            "Nhắc người dùng về một khoản thanh toán hoặc lần gia hạn sắp tới: "
            "{what}. Viết như một lời nhắc kèm việc nên làm (ví dụ: xem lại hoặc "
            "huỷ trước khi gói tự gia hạn), không chỉ thông báo suông. Một tin "
            "nhắn ngắn."
        ),
        "slots": {
            "what": {
                "label": "Khoản nào sắp đến hạn?",
                "default": "gói xem phim trực tuyến của tôi sắp gia hạn",
            },
        },
    },
    "habit-checkin": {
        "title": "Nhắc giữ thói quen",
        "description": "Lời nhắc định kỳ giúp bạn giữ một thói quen và tự nhìn "
        "lại xem mình đã làm chưa.",
        "prompt": (
            "Nhắc người dùng về thói quen: {habit}. Hỏi xem hôm nay họ đã làm "
            "chưa, giọng ấm áp, không phán xét, kèm một câu động viên. Một tin "
            "nhắn ngắn."
        ),
        "slots": {
            "habit": {
                "label": "Thói quen nào?",
                "default": "đọc sách 20 phút",
            },
        },
    },
    "hydration-move": {
        "title": "Nhắc uống nước và vận động",
        "description": "Thỉnh thoảng trong ngày nhắc bạn uống nước, đứng dậy và "
        "vươn vai.",
        "prompt": (
            "Gửi người dùng một lời nhắc ngắn, thân thiện: uống chút nước, đứng "
            "dậy và vươn vai một lát. Mỗi lần đổi cách nói để không máy móc. Chỉ "
            "một dòng ngắn."
        ),
        "slots": {
            "interval_hours": {
                "label": "Bao lâu nhắc một lần?",
                "help": "Khoảng cách giữa hai lần nhắc",
                "options": {"1": "Mỗi giờ", "2": "2 giờ một lần", "3": "3 giờ một lần"},
            },
            "start_hour": {
                "label": "Bắt đầu nhắc từ",
                "help": "Giờ đầu tiên trong khung nhắc",
                "options": {"7": "07:00", "8": "08:00", "9": "09:00", "10": "10:00"},
            },
            "end_hour": {
                "label": "Nhắc đến hết",
                "help": "Giờ cuối cùng trong khung nhắc",
                "options": {"16": "16:00", "17": "17:00", "18": "18:00", "19": "19:00"},
            },
        },
    },
    "meal-plan": {
        "title": "Thực đơn hằng tuần",
        "description": "Thực đơn cả tuần kèm danh sách đi chợ, theo chế độ ăn và "
        "thời gian nấu nướng của bạn.",
        "prompt": (
            "Lên thực đơn tuần tới cho người dùng. Số bữa mỗi ngày: {meals}. Chế "
            "độ ăn: {diet}. Mức công nấu: {effort}. Kèm một danh sách đi chợ gộp "
            "chung, chia theo quầy hàng. Món ăn đơn giản, trình bày dễ lướt."
        ),
        "slots": {
            "diet": {
                "label": "Chế độ ăn?",
                "options": {
                    "no restrictions": "Không kiêng gì",
                    "vegetarian": "Ăn chay",
                    "vegan": "Thuần chay",
                    "high-protein": "Giàu đạm",
                    "low-carb": "Ít tinh bột",
                },
            },
            "meals": {
                "label": "Mỗi ngày mấy bữa?",
                "options": {
                    "dinner only": "Chỉ bữa tối",
                    "lunch and dinner": "Bữa trưa và bữa tối",
                    "all three": "Cả ba bữa",
                },
            },
            "effort": {
                "label": "Mức công nấu?",
                "options": {
                    "quick": "Nhanh gọn",
                    "medium": "Vừa phải",
                    "ambitious": "Cầu kỳ",
                },
            },
        },
    },
    "learn-daily": {
        "title": "Mỗi ngày một bài học",
        "description": "Mỗi ngày một bài học nhỏ về chủ đề bạn muốn học, nâng "
        "dần theo thời gian.",
        "prompt": (
            "Dạy người dùng một bài học nhỏ về: {topic}. Nối tiếp các bài trước "
            "để kiến thức tiến dần chứ không lặp lại. Gói trong vài đoạn ngắn "
            "với một ví dụ cụ thể, và kết bằng đúng một câu hỏi để kiểm tra mức "
            "hiểu."
        ),
        "slots": {
            "topic": {
                "label": "Muốn học về…",
                "default": "từ vựng tiếng Anh",
            },
        },
    },
    "gratitude-journal": {
        "title": "Biết ơn và suy ngẫm",
        "description": "Lời gợi ý nhẹ nhàng mỗi tối để nhìn lại một ngày và ghi "
        "nhận điều tốt đẹp.",
        "prompt": (
            "Gửi người dùng một lời gợi ý suy ngẫm ngắn, ấm áp vào cuối ngày: "
            "mời họ ghi lại một điều suôn sẻ, một điều họ biết ơn và một thành "
            "công nhỏ. Nếu họ trả lời, hãy đáp lại ân cần. Một tin nhắn."
        ),
    },
    "on-this-day": {
        "title": "Mỗi ngày một điều thú vị",
        "description": "Mỗi ngày một chút tò mò: một sự kiện lịch sử, một sự thật "
        "hay một từ đáng nhớ.",
        "prompt": (
            "Gửi người dùng một mục thú vị cho hôm nay, thuộc loại: {flavor}. "
            "Ngắn, bất ngờ và thật sự đáng đọc. Một hai câu, không rào đón."
        ),
        "slots": {
            "flavor": {
                "label": "Loại nội dung?",
                "options": {
                    "on this day in history": "Ngày này năm xưa",
                    "word of the day": "Từ vựng của ngày",
                    "science fact": "Sự thật khoa học",
                    "quote of the day": "Câu nói của ngày",
                },
            },
        },
    },
}


TRANSLATIONS: Dict[str, Dict[str, Any]] = {
    "vi": {"shared_slots": _VI_SHARED_SLOTS, "blueprints": _VI},
}


def normalize_locale(locale: Optional[str]) -> Optional[str]:
    """Map a UI locale ("vi", "vi-VN", "VI_vn") to a table key, or ``None``.

    ``None`` means "serve the catalog as written" (English).
    """
    if not locale:
        return None
    base = str(locale).strip().lower().replace("_", "-").split("-", 1)[0]
    return base if base in TRANSLATIONS else None


def blueprint_text(key: str, locale: Optional[str]) -> Dict[str, Any]:
    """The translated title/description/prompt for blueprint *key* ({} if none)."""
    table = TRANSLATIONS.get(normalize_locale(locale) or "")
    if not table:
        return {}
    return table["blueprints"].get(key, {})


def slot_text(key: str, slot_name: str, locale: Optional[str]) -> Dict[str, Any]:
    """The translated label/help/default/options for one slot ({} if none).

    A blueprint's own entry is layered over the shared one, key by key, so a
    blueprint can reword a shared slot's label and still inherit its options.
    """
    table = TRANSLATIONS.get(normalize_locale(locale) or "")
    if not table:
        return {}
    shared = table["shared_slots"].get(slot_name, {})
    own = table["blueprints"].get(key, {}).get("slots", {}).get(slot_name, {})
    if not shared:
        return dict(own)
    merged = dict(shared)
    for name, value in own.items():
        if name == "options" and isinstance(merged.get("options"), dict):
            merged["options"] = {**merged["options"], **value}
        else:
            merged[name] = value
    return merged
