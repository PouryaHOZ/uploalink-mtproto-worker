#!/usr/bin/env python3
"""
Generate 10,000 unique pure donation messages.
Output: src/data/messages.ts (TypeScript array)

Selection strategy: SEQUENTIAL (first available).
Distribution: ~50% short (10-30 chars), ~40% medium (30-80), ~10% long (80-150)
Styles: ~3400 formal, ~3300 colloquial, ~3300 finglish
NO embedded code -- the message text itself is the unique identifier.
"""

import random
import re
from pathlib import Path
from datetime import datetime

random.seed(42)  # reproducible output

# ===== 3 phrase banks, each 3 layers x 24 items =====
PHRASES = {
    "formal": {
        "openers": [
            "سلام و احترام،",
            "با تقدیم احترام،",
            "سلام خدمت تیم محترم،",
            "ارادتمندانه،",
            "خدا قوت به همراهان گرامی،",
            "سلام و عرض ادب،",
            "با سلام و احترام خدمت شما،",
            "ارادتمندانه اعلام می\u200cدارم که",
            "سلام خدمت همه عزیزان،",
            "با تجدید احترام،",
            "خدا قوت به شما تیم محترم،",
            "سلام و درود،",
            "با احترام خدمت شما،",
            "سلام خدمت همراهان گرامی،",
            "ارادتمند شما هستم و اعلام می\u200cکنم که",
            "با سلام و تحیات،",
            "خدا قوت،",
            "سلام و احترام خدمت همه،",
            "با آرزوی موفقیت،",
            "سلام خدمت اساتید گرامی،",
            "با تجدید ارادت،",
            "ارادتمندانه اعلام می\u200cنمایم،",
            "سلام و عرض ادب خدمت شما،",
            "با احترام و تجدید ارادت،",
        ],
        "bodies": [
            "مبلغ فوق جهت حمایت ارسال گردید.",
            "این کمک کوچک قدردانی از زحمات شماست.",
            "بخشی از حق\u200cالزحمه خدمتگزاران پروژه است.",
            "مبلغی ناچیز جهت حمایت از پروژه ارسال شد.",
            "این مبلغ به\u200cعنوان قدردانی ارسال گردید.",
            "بخشی از هزینه\u200cهای پروژه را تأمین می\u200cکند.",
            "جهت حمایت از فعالیت\u200cهای شما ارسال شد.",
            "این کمک در راستای پیشبرد پروژه است.",
            "مبلغ فوق برای پشتیبانی پروژه ارسال گردید.",
            "بخشی از کمک\u200cهای مردمی به پروژه است.",
            "این مبلغ قدردانی از زحمات بی\u200cدریغ شماست.",
            "جهت پشتیبانی از تلاش\u200cهای شما ارسال گردید.",
            "مبلغی برای حمایت از کار شما ارسال شد.",
            "این کمک کوچک در راستای اهداف پروژه است.",
            "بخشی از هزینه\u200cهای لازم برای پروژه است.",
            "مبلغ فوق به\u200cعنوان حمایت ارسال گردید.",
            "این کمک برای ادامه مسیر شماست.",
            "جهت قدردانی از تلاش\u200cهایتان ارسال شد.",
            "مبلغی ناچیز در راه حمایت از پروژه.",
            "این مبلغ برای پشتیبانی از کار شماست.",
            "بخشی از کمک\u200cهای لازم برای پروژه است.",
            "مبلغ فوق در راستای حمایت از شماست.",
            "این کمک کوچک برای پیشبرد کار شماست.",
            "جهت پشتیبانی از فعالیت\u200cهای ارزشمندتان.",
        ],
        "closers": [
            "موفق باشید.",
            "با تجدید احترام،",
            "ارادتمند شما،",
            "موفق و پیروز باشید،",
            "با آرزوی موفقیت،",
            "خدا قوت.",
            "موفق باشید در مسیر.",
            "با تجدید ارادت،",
            "خدا نگهدار شما.",
            "موفق و سربلند باشید.",
            "با احترام،",
            "ارادتمند.",
            "موفق باشید همواره.",
            "با سلام و احترام،",
            "خدا یارتان.",
            "موفق باشید در راه.",
            "با آرزوی توفیق،",
            "خدا به یاریتان.",
            "موفق باشید همیشه.",
            "با تجدید احترام و ارادت،",
            "ارادتمند شما هستم.",
            "موفق و پیروز باشید در مسیر.",
            "خدا قوت به شما.",
            "با احترام و آرزوی موفقیت،",
        ],
        "extras": [
            "امیدوارم در مسیر موفقیت همواره پیشرو باشید.",
            "تلاش\u200cهای ارزشمندتان قطعاً به نتیجه خواهد رسید.",
            "با آرزوی آنکه پروژه به موفقیت\u200cهای بزرگ برسد.",
            "امیدوارم زحمات شما به ثمر بنشیند.",
            "با امید به موفقیت روزافزون شما.",
            "تلاش\u200cهای شما قابل تحسین است.",
            "امیدوارم همواره در اوج موفقیت باشید.",
            "با آرزوی آنکه اهداف پروژه محقق گردد.",
            "امیدوارم فعالیت\u200cهای شما گسترش یابد.",
            "با امید به پیشرفت روزافزون شما.",
            "تلاش\u200cهای ارزشمند شما قابل تقدیر است.",
            "امیدوارم در مسیر خدمت موفق باشید.",
            "با آرزوی موفقیت\u200cهای بیشتر برای پروژه.",
            "امیدوارم کار شما به دلایل خیر برسد.",
            "با امید به آنکه زحمات شما جبران شود.",
            "تلاش\u200cهای بی\u200cوقفه شما قابل ستایش است.",
            "امیدوارم در ادامه مسیر موفق باشید.",
            "با آرزوی آنکه پروژه به اهداف خود برسد.",
            "امیدوارم همواره پیشرو باشید.",
            "تلاش شما برای پروژه ارزشمند است.",
            "با امید به موفقیت پایدار شما.",
            "امیدوارم زحماتتان به نتیجه برسد.",
            "با آرزوی موفقیت در تمام مراحل.",
            "امیدوارم همیشه موفق باشید.",
        ],
    },
    "colloquial": {
        "openers": [
            "سلام داداش،",
            "سلام رفیق،",
            "خسته نباشی بچه\u200cها،",
            "سلااام،",
            "سلام داداش گلم،",
            "خسته نباشی،",
            "سلام به همه،",
            "سلام دوستان،",
            "سلااام داداش،",
            "خسته نباشی رفیق،",
            "سلام آرش جان،",
            "سلام بچه\u200cها،",
            "داداش خسته نباشی،",
            "سلام داداش خوبی؟",
            "سلام رفقا،",
            "خسته نباشی داداش،",
            "سلام عزیزم،",
            "سلام داداش شریفی،",
            "سلام برادر،",
            "سلام دوست عزیز،",
            "خسته نباشی برادر،",
            "سلام اقا آرش،",
            "سلااام رفیق،",
            "سلام داداش گل،",
        ],
        "bodies": [
            "اینم یه کم کمک از طرف من.",
            "خیلی کارت درسته.",
            "دمت گرم با این کارت.",
            "اینم یه کم پول برات.",
            "بفرما داداش اینم از طرف من.",
            "اینم سهم من.",
            "اینم یه کم کمک.",
            "داداش دمت گرم.",
            "کارتی کردی دمت گرم.",
            "اینم یه کم کمک برات.",
            "بفرما اینم از من.",
            "اینم یه خورده پول.",
            "داداش خیلی خوبی.",
            "اینم یه کم کمکی.",
            "دمت گرم داداش.",
            "اینم یه کم برات.",
            "خیلی مردی.",
            "اینم کم من.",
            "داداش خیلی زدی.",
            "اینم سهم من برات.",
            "داداش دمت گرم.",
            "بفرما اینم یه کم.",
            "کار درست کردی.",
            "اینم یه کم کمک داداش.",
        ],
        "closers": [
            "موفق باشی.",
            "خدا قوت.",
            "داداش بازی در آوردی.",
            "موفق باشی داداش.",
            "خدا نگهدارت.",
            "دمت گرم.",
            "مردی کردی.",
            "موفق باشی همیشه.",
            "خدا به یارت.",
            "داداش خیلی خوبی.",
            "موفق باشی رفیق.",
            "خدا قوت داداش.",
            "مردی.",
            "دمت گرم داداش.",
            "موفق باشی برادر.",
            "خدا نگهدار.",
            "موفق باشی همیشگی.",
            "خدا قوت رفیق.",
            "داداش دمت گرم.",
            "موفق باشی عزیزم.",
            "خدا به یاریت.",
            "موفق باشی داداش گلم.",
            "خدا قوت برادر.",
            "مردی.",
        ],
        "extras": [
            "امیدوارم همیشه موفق باشی.",
            "حتماً به موفقیت می\u200cرسی داداش.",
            "کار همیشگی درست کردی.",
            "خیلی مردی داداش.",
            "امیدوارم کارت بره جلو.",
            "حتماً موفق می\u200cشی.",
            "همیشه دمت گرم.",
            "کار ارزشمندی کردی.",
            "امیدوارم به همه اهدافت برسی.",
            "داداش خیلی زدی.",
            "حتماً پیشرفت می\u200cکنی.",
            "امیدوارم همیشه پیشرو باشی.",
            "کار درست و خوبی کردی.",
            "خیلی خوبی داداش.",
            "امیدوارم موفق باشی همیشه.",
            "حتماً به جایی می\u200cرسی.",
            "کار همیشگی مردانه\u200cای.",
            "امیدوارم کارت گسترش پیدا کنه.",
            "حتماً موفق خواهی بود.",
            "داداش کارت عالیه.",
            "امیدوارم همیشه موفق باشی داداش.",
            "حتماً به موفقیت\u200cهای بزرگ می\u200cرسی.",
            "کار همیشه درست کردی.",
            "امیدوارم به اهدافت برسی.",
        ],
    },
    "finglish": {
        "openers": [
            "Salam dadash,",
            "Salam azizam,",
            "Khaste nabashi team,",
            "Slaaam,",
            "Salam dadash gol,",
            "Khaste nabashi,",
            "Salam be hame,",
            "Salam doostan,",
            "Slaaam dadash,",
            "Khaste nabashi rafiq,",
            "Salam aziz,",
            "Salam bachcheha,",
            "Dadash khaste nabashi,",
            "Salam rafiq,",
            "Salam rafaqa,",
            "Khaste nabashi dadash,",
            "Salam azizam man,",
            "Salam dadash sharifi,",
            "Salam baradar,",
            "Salam doost aziz,",
            "Khaste nabashi baradar,",
            "Salam agha arash,",
            "Slaaam rafiq,",
            "Salam dadash jan,",
        ],
        "bodies": [
            "inam yek komak az samte man.",
            "kheili kart doroste.",
            "damet garm.",
            "inam yek kam pool barat.",
            "befarma dadash inam az samte man.",
            "inam sahm e man.",
            "inam yek kam komak.",
            "dadash damet garm.",
            "karti kardi damet garm.",
            "inam yek kam komak barat.",
            "befarma inam az man.",
            "inam yek khorde pool.",
            "dadash kheili khoobi.",
            "inam yek kam komaki.",
            "damet garm dadash.",
            "inam yek kam barat.",
            "kheili mardi.",
            "inam kam e man.",
            "dadash kheili zadi.",
            "inam sahm e man barat.",
            "dadash damet garm.",
            "befarma inam yek kam.",
            "kar dorost kardi.",
            "inam yek kam komak dadash.",
        ],
        "closers": [
            "Movahaz bashi.",
            "Khoda posht o sarat.",
            "Damet garm dadash.",
            "Movahaz bashi dadash.",
            "Khoda negahdart.",
            "Damet garm.",
            "Mardi kardi.",
            "Movahaz bashi hameshe.",
            "Khoda be yaret.",
            "Dadash kheili khoobi.",
            "Movahaz bashi rafiq.",
            "Khoda ghovat dadash.",
            "Mardi.",
            "Damet garm dadash.",
            "Movahaz bashi baradar.",
            "Khoda negahdar.",
            "Movahaz bashi hameshegi.",
            "Khoda ghovat rafiq.",
            "Dadash damet garm.",
            "Movahaz bashi azizam.",
            "Khoda be yariyat.",
            "Movahaz bashi dadash gol.",
            "Khoda ghovat baradar.",
            "Mardi.",
        ],
        "extras": [
            "Omidvaram hameshe movahaz bashi.",
            "Hatman be movafaghiyat miresi dadash.",
            "Kar hameshe dorost kardi.",
            "Kheili mardi dadash.",
            "Omidvaram kart bere jolo.",
            "Hatman movafagh mish.",
            "Hameshe damet garm.",
            "Kar arzeshmandi kardi.",
            "Omidvaram be hame hadafat beresi.",
            "Dadash kheili zadi.",
            "Hatman pishraft mikoni.",
            "Omidvaram hameshe pishro bashi.",
            "Kar dorost o khoobi kardi.",
            "Kheili khoobi dadash.",
            "Omidvaram movafagh bashi hameshe.",
            "Hatman be jayi miresi.",
            "Kar hameshe mardanei.",
            "Omidvaram kart gosharesh peyda kone.",
            "Hatman movafagh khahi bud.",
            "Dadash kart alie.",
            "Omidvaram hameshe movafagh bashi dadash.",
            "Hatman be movafaghiyat haye bozorg miresi.",
            "Kar hameshe dorost kardi.",
            "Omidvaram be hadafat beresi.",
        ],
    },
}

EMOJIS = ["", "", "", "", "❤️", "👍", "🙌", "💪", "✨", "🌟", "🔥", "💯"]


def gen_message(style: str):
    """Generate one pure message (no embedded code)."""
    layers = PHRASES[style]

    length_cat = random.choices(["short", "medium", "long"], weights=[50, 40, 10])[0]

    opener = random.choice(layers["openers"])
    body = random.choice(layers["bodies"])
    closer = random.choice(layers["closers"])
    extra = random.choice(layers["extras"])

    emoji_count = random.choices([0, 1, 2], weights=[55, 35, 10])[0]
    emojis = "".join(random.sample(EMOJIS[4:], emoji_count)) if emoji_count else ""

    if length_cat == "short":
        pattern = random.randint(0, 1)
        if pattern == 0:
            text = f"{opener} {body}{emojis}"
        else:
            text = f"{body} {closer}{emojis}"
    elif length_cat == "medium":
        pattern = random.randint(0, 2)
        if pattern == 0:
            text = f"{opener} {body} {closer}{emojis}"
        elif pattern == 1:
            text = f"{opener}{emojis} {body} {closer}"
        else:
            text = f"{opener} {body} {closer} {emojis}".strip()
    else:  # long
        pattern = random.randint(0, 1)
        if pattern == 0:
            text = f"{opener} {body} {extra} {closer}{emojis}"
        else:
            text = f"{opener}{emojis} {body} {extra} {closer}"

    text = " ".join(text.split())
    return text, length_cat


def normalize(s: str) -> str:
    """Normalize for uniqueness check."""
    return re.sub(r"\s+", " ", s).strip().lower()


def main():
    seen_normalized = set()
    messages = []

    styles = (["formal"] * 3400 +
              ["colloquial"] * 3300 +
              ["finglish"] * 3300)
    random.shuffle(styles)

    for i, style in enumerate(styles):
        for attempt in range(200):
            text, length_cat = gen_message(style)
            norm = normalize(text)
            if norm not in seen_normalized:
                seen_normalized.add(norm)
                messages.append({
                    "text": text,
                    "style": style,
                    "length_category": length_cat,
                    "char_count": len(text),
                })
                break
        else:
            raise RuntimeError(
                f"Could not generate unique message after 200 attempts at index {i}"
            )

    assert len(messages) == 10000
    assert len(seen_normalized) == 10000

    short = sum(1 for m in messages if m["length_category"] == "short")
    medium = sum(1 for m in messages if m["length_category"] == "medium")
    long_ = sum(1 for m in messages if m["length_category"] == "long")
    formal = sum(1 for m in messages if m["style"] == "formal")
    colloquial = sum(1 for m in messages if m["style"] == "colloquial")
    finglish = sum(1 for m in messages if m["style"] == "finglish")

    output_path = Path("src/data/messages.ts")
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        f.write("// AUTO-GENERATED by scripts/generate_messages.py -- DO NOT EDIT\n")
        f.write(f"// Generated: {datetime.now().isoformat()}\n")
        f.write("// 10,000 unique pure donation messages (no embedded code)\n")
        f.write("// The message text itself is the unique identifier.\n")
        f.write(f"// Distribution: short={short} ({short/100:.0f}%), "
                f"medium={medium} ({medium/100:.0f}%), long={long_} ({long_/100:.0f}%)\n")
        f.write(f"// Styles: formal={formal}, colloquial={colloquial}, finglish={finglish}\n")
        f.write("// Selection strategy: sequential (first available not locked/used)\n\n")
        f.write("export const MESSAGES: readonly string[] = [\n")
        for m in messages:
            safe = m["text"].replace("\\", "\\\\").replace('"', '\\"')
            f.write(f'  "{safe}",\n')
        f.write("] as const;\n\n")
        f.write(f"export const MESSAGE_COUNT = {len(messages)};\n")
        f.write("export type MessageIndex = number; // 0..9999\n")

    print(f"Generated {len(messages)} unique messages -> {output_path}")
    print(f"   Short:  {short} ({short/100:.0f}%)")
    print(f"   Medium: {medium} ({medium/100:.0f}%)")
    print(f"   Long:   {long_} ({long_/100:.0f}%)")
    print(f"   Styles: formal={formal}, colloquial={colloquial}, finglish={finglish}")


if __name__ == "__main__":
    main()
