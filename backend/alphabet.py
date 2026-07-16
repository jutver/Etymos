"""
================================================================================
 MÔ PHỎNG PHÁT ÂM BẢNG CHỮ CÁI BẰNG TỔNG HỢP ÂM THANH VẬT LÝ
 (Physically-based Speech Synthesis — Source-Filter Model, Fant 1960)
================================================================================

NGUYÊN LÝ VẬT LÝ & TOÁN HỌC
---------------------------
Lời nói con người được mô hình hoá bằng mô hình NGUỒN - LỌC (source-filter):

    Tín hiệu ra  s(t)  =  Nguồn kích thích e(t)  *  Đáp ứng ống thanh quản h(t)

1) NGUỒN KÍCH THÍCH (excitation source)
   - Âm hữu thanh (nguyên âm, m, n, l, r...): dây thanh dao động chu kỳ ở tần số
     F0 (pitch). Ta dùng sóng răng cưa (sawtooth) vì phổ tần của nó suy giảm
     tự nhiên -12dB/octave, giống phổ glottal pulse thật:

         e(t) = (2/π) * Σ_{k=1}^{N} [ (-1)^(k+1) / k ] * sin(2π k F0 t)

   - Âm vô thanh (s, t, k, f, h...): luồng khí cuộn xoáy hỗn loạn qua khe hẹp,
     mô hình bằng nhiễu trắng (white Gaussian noise) e(t) = N(0, σ²)

2) BỘ LỌC CỘNG HƯỞNG (formant filter / vocal tract resonances)
   Ống thanh quản hoạt động như nhiều bộ cộng hưởng (formant) tại các tần số
   F1, F2, F3. Mỗi formant được mô hình bằng một bộ lọc cộng hưởng số bậc 2
   (digital resonator) theo phương trình sai phân:

         y[n] = a1*y[n-1] + a2*y[n-2] + b0*x[n]

   với:
         R  = exp(-π * BW / fs)              (hệ số tắt dần theo bandwidth)
         a1 = 2*R*cos(2π*F/fs)
         a2 = -R²
         b0 = (1 - a2) * sin(2π*F/fs)         (chuẩn hoá biên độ cộng hưởng)

   Đây chính xác là công thức bộ lọc formant Klatt/Holmes dùng trong các hệ
   tổng hợp tiếng nói formant kinh điển (Klatt 1980), suy ra trực tiếp từ
   phương trình dao động cơ học tắt dần (damped harmonic oscillator):

         d²y/dt² + (2π·BW)·dy/dt + (2π·F)²·y = x(t)

3) NGUYÊN ÂM ĐÔI (diphthong) — phương trình nội suy tuyến tính
         F(t) = F_a + (F_b - F_a) * (t / T),   0 ≤ t ≤ T

4) PHONG BÌ BIÊN ĐỘ (amplitude envelope) — attack/release dạng hàm mũ
         A(t) = A_peak * (1 - e^{-t/τ_a})         (tấn công)
         A(t) = A_peak * e^{-(t-t0)/τ_r}          (nhả)

CÀI ĐẶT
-------
    pip install numpy scipy --break-system-packages
    (tuỳ chọn để phát âm thanh trực tiếp): pip install sounddevice
    Nếu không có sounddevice, script sẽ tự ghi file .wav và mở bằng trình phát
    mặc định của hệ điều hành.

CHẠY
----
    python alphabet_speech_synth.py          # mở giao diện Tkinter
    python alphabet_speech_synth.py A B C    # tổng hợp & lưu wav cho từng chữ
================================================================================
"""

import math
import os
import sys
import platform
import subprocess
import tempfile
import wave
import struct

import numpy as np
from scipy.signal import lfilter

FS = 22050  # tần số lấy mẫu (Hz) - đủ cho dải tiếng nói (telephone-grade+)

# ============================================================================
# PHẦN 1 — BẢNG DỮ LIỆU VẬT LÝ: FORMANT NGUYÊN ÂM (Hz)
# Xấp xỉ giọng nam trung bình, theo nghiên cứu cổ điển Peterson & Barney (1952)
# ============================================================================
VOWELS = {
    "i":      (270, 2300, 3000),   # "ee" trong "see"
    "e":      (400, 2000, 2700),   # "e" trong "bed"
    "ae":     (660, 1700, 2400),   # "a" trong "cat"
    "a":      (710, 1100, 2540),   # "ah" trong "father"
    "o":      (570,  850, 2400),   # "o" trong "go" (đầu)
    "oU":     (450, 1000, 2400),   # "o" trong "go" (cuối)
    "u":      (300,  870, 2240),   # "oo" trong "boot"
    "schwa":  (500, 1500, 2500),   # nguyên âm trung tính /ə/
    "E":      (550, 1850, 2600),   # /ɛ/ trong "egg"
    "eI_a":   (660, 1700, 2400),   # bắt đầu diphthong /eɪ/
    "eI_b":   (400, 2200, 2800),   # kết thúc diphthong /eɪ/
    "aI_a":   (710, 1100, 2540),   # bắt đầu diphthong /aɪ/
    "aI_b":   (400, 2300, 2900),   # kết thúc diphthong /aɪ/
}

BW = (90, 110, 170)        # bandwidth (Hz) tương ứng F1,F2,F3 — quyết định độ "sắc" cộng hưởng
GAINS = (1.0, 0.55, 0.28)  # biên độ tương đối từng formant (suy giảm phổ tự nhiên)

# Phụ âm: loại kích thích, băng tần nhiễu, hoặc formant đặc trưng (nasal/liquid/glide)
CONS = {
    "b":  dict(type="stop",  voiced=True,  band=(200, 1500),  dur=0.05),
    "d":  dict(type="stop",  voiced=True,  band=(300, 3500),  dur=0.045),
    "dj": dict(type="stop",  voiced=True,  band=(150, 2000),  dur=0.05),   # "g/j" /dʒ/
    "k":  dict(type="stop",  voiced=False, band=(1500, 4500), dur=0.05),
    "p":  dict(type="stop",  voiced=False, band=(400, 1800),  dur=0.05),
    "t":  dict(type="stop",  voiced=False, band=(3000, 6000), dur=0.04),
    "f":  dict(type="fric",  voiced=False, band=(2000, 7000), dur=0.13),
    "v":  dict(type="fric",  voiced=True,  band=(200, 1500),  dur=0.10),
    "s":  dict(type="fric",  voiced=False, band=(4000, 8000), dur=0.15),
    "z":  dict(type="fric",  voiced=True,  band=(3000, 7000), dur=0.12),
    "sh": dict(type="fric",  voiced=False, band=(2000, 4500), dur=0.13),
    "h":  dict(type="fric",  voiced=False, band=(500, 3000),  dur=0.09),
    "l":  dict(type="formant", voiced=True, f=(360, 1300, 2800), dur=0.10),
    "m":  dict(type="formant", voiced=True, f=(280, 900, 2200),  dur=0.12),
    "n":  dict(type="formant", voiced=True, f=(280, 1700, 2600), dur=0.10),
    "r":  dict(type="formant", voiced=True, f=(460, 1100, 1500), dur=0.11),
    "w":  dict(type="formant", voiced=True, f=(300, 700, 2300),  dur=0.08),
    "y":  dict(type="formant", voiced=True, f=(260, 2300, 3000), dur=0.07),
}

# ============================================================================
# PHẦN 2 — TRÌNH TỰ ÂM VỊ CHO TÊN 26 CHỮ CÁI TIẾNG ANH
# ============================================================================
def V(name, dur):
    return ("vowel", VOWELS[name], dur)

def G(a, b, dur):
    return ("glide", VOWELS[a], VOWELS[b], dur)

def C(key):
    return ("cons", key, CONS[key]["dur"])

LETTERS = {
    "A": [G("eI_a", "eI_b", 0.22)],
    "B": [C("b"), V("i", 0.20)],
    "C": [C("s"), V("i", 0.20)],
    "D": [C("d"), V("i", 0.20)],
    "E": [V("i", 0.22)],
    "F": [V("E", 0.10), C("f")],
    "G": [C("dj"), V("i", 0.20)],
    "H": [G("eI_a", "eI_b", 0.16), C("sh"), C("t")],
    "I": [G("aI_a", "aI_b", 0.24)],
    "J": [C("dj"), G("eI_a", "eI_b", 0.20)],
    "K": [C("k"), G("eI_a", "eI_b", 0.20)],
    "L": [V("E", 0.10), C("l")],
    "M": [V("E", 0.10), C("m")],
    "N": [V("E", 0.10), C("n")],
    "O": [G("o", "oU", 0.24)],
    "P": [C("p"), V("i", 0.20)],
    "Q": [C("k"), C("y"), V("u", 0.20)],
    "R": [V("a", 0.10), C("r")],
    "S": [V("E", 0.10), C("s")],
    "T": [C("t"), V("i", 0.20)],
    "U": [C("y"), V("u", 0.22)],
    "V": [C("v"), V("i", 0.20)],
    "W": [C("d"), V("schwa", 0.08), C("b"), C("l"), V("u", 0.18)],
    "X": [V("E", 0.10), C("k"), C("s")],
    "Y": [G("aI_a", "aI_b", 0.24)],
    "Z": [V("i", 0.05), C("z"), V("i", 0.20)],
}

IPA = {"A":"eɪ","B":"biː","C":"siː","D":"diː","E":"iː","F":"ɛf","G":"dʒiː","H":"eɪtʃ",
       "I":"aɪ","J":"dʒeɪ","K":"keɪ","L":"ɛl","M":"ɛm","N":"ɛn","O":"oʊ","P":"piː",
       "Q":"kjuː","R":"ɑːr","S":"ɛs","T":"tiː","U":"juː","V":"viː","W":"dʌbljuː",
       "X":"ɛks","Y":"waɪ","Z":"ziː"}


# ============================================================================
# PHẦN 3 — ĐỘNG CƠ TỔNG HỢP (DSP thuần numpy/scipy)
# ============================================================================
def glottal_source(n_samples, f0, fs=FS):
    """Nguồn kích thích hữu thanh: sóng răng cưa qua tổng Fourier hữu hạn.
    e(t) = (2/π) Σ (-1)^(k+1)/k * sin(2π k F0 t)
    """
    t = np.arange(n_samples) / fs
    n_harm = int(fs / 2 / max(f0, 1)) - 1
    n_harm = max(1, min(n_harm, 40))
    sig = np.zeros(n_samples)
    for k in range(1, n_harm + 1):
        sig += ((-1) ** (k + 1) / k) * np.sin(2 * np.pi * k * f0 * t)
    sig *= (2 / np.pi)
    return sig / (np.max(np.abs(sig)) + 1e-9)


def noise_source(n_samples, rng):
    return rng.normal(0, 1, n_samples)


def resonator_filter(x, freq, bw, fs=FS):
    """Bộ lọc cộng hưởng số bậc 2 (digital resonator), suy ra từ phương trình
    dao động tắt dần (damped harmonic oscillator):
        R  = exp(-π·BW/fs)
        a1 = 2R cos(2π F/fs);   a2 = -R²
        b0 = (1-a2) sin(2π F/fs)
    y[n] = b0*x[n] + a1*y[n-1] + a2*y[n-2]
    """
    R = math.exp(-math.pi * bw / fs)
    theta = 2 * math.pi * freq / fs
    a1 = 2 * R * math.cos(theta)
    a2 = -R * R
    b0 = (1 - a2) * math.sin(theta) if math.sin(theta) != 0 else (1 - a2)
    b = [b0]
    a = [1, -a1, -a2]
    return lfilter(b, a, x)


def time_varying_resonator(x, freq_array, bw, fs=FS):
    """Resonator với tần số thay đổi theo thời gian (cho diphthong), cập nhật
    hệ số bộ lọc theo từng mẫu — mô phỏng formant 'trượt' liên tục F(t)."""
    y = np.zeros_like(x)
    y1 = y2 = 0.0
    R = math.exp(-math.pi * bw / fs)
    for n in range(len(x)):
        theta = 2 * math.pi * freq_array[n] / fs
        a1 = 2 * R * math.cos(theta)
        a2 = -R * R
        s = math.sin(theta)
        b0 = (1 - a2) * s if s != 0 else (1 - a2)
        yn = b0 * x[n] + a1 * y1 + a2 * y2
        y[n] = yn
        y2, y1 = y1, yn
    return y


def envelope(n_samples, dur, fs=FS, attack=0.012, release=0.05, peak=1.0):
    """Phong bì biên độ dạng tấn công/duy trì/nhả theo hàm mũ."""
    t = np.arange(n_samples) / fs
    env = np.full(n_samples, peak, dtype=float)
    a_n = int(attack * fs)
    r_n = int(release * fs)
    if a_n > 0:
        env[:a_n] = peak * (1 - np.exp(-t[:a_n] / (attack / 3 + 1e-6)))
    if r_n > 0 and r_n < n_samples:
        tail = t[-r_n:] - t[-r_n]
        env[-r_n:] = peak * np.exp(-tail / (release / 3 + 1e-6))
    return env


def synth_vowel(formants, dur, f0, fs=FS, glide_to=None):
    n = int(dur * fs)
    src = glottal_source(n, f0, fs)
    out = np.zeros(n)
    for i, f in enumerate(formants):
        if glide_to is not None:
            f_end = glide_to[i]
            f_arr = np.linspace(f, f_end, n)
            branch = time_varying_resonator(src.copy(), f_arr, BW[i], fs)
        else:
            branch = resonator_filter(src, f, BW[i], fs)
        out += GAINS[i] * branch
    out *= envelope(n, dur, fs)
    return out


def synth_consonant(spec, dur, f0, rng, fs=FS):
    n = int(dur * fs)
    if spec["type"] in ("stop", "fric"):
        noise = noise_source(n, rng)
        lo, hi = spec["band"]
        center = (lo + hi) / 2
        bw = (hi - lo)
        branch = resonator_filter(noise, center, max(bw, 50), fs)
        peak = 0.9 if spec["type"] == "stop" else 0.55
        atk = 0.003 if spec["type"] == "stop" else 0.02
        out = branch * envelope(n, dur, fs, attack=atk, release=dur * 0.6, peak=peak)
        if spec.get("voiced"):
            voiced = glottal_source(n, f0, fs)
            voiced = resonator_filter(voiced, 400, 150, fs)
            out += voiced * envelope(n, dur, fs, attack=0.005, release=dur * 0.5, peak=0.25)
        return out
    else:  # formant-based: nasal / liquid / glide
        return synth_vowel(spec["f"], dur, f0, fs)


def synth_letter(letter, f0=120, rate=1.0, fs=FS, seed=0):
    rng = np.random.default_rng(seed)
    chunks = []
    for part in LETTERS[letter]:
        kind = part[0]
        if kind == "vowel":
            _, formants, dur = part
            chunks.append(synth_vowel(formants, dur / rate, f0, fs))
        elif kind == "glide":
            _, f_a, f_b, dur = part
            chunks.append(synth_vowel(f_a, dur / rate, f0, fs, glide_to=f_b))
        elif kind == "cons":
            _, key, dur = part
            chunks.append(synth_consonant(CONS[key], dur / rate, f0, rng, fs))
    sig = np.concatenate(chunks) if chunks else np.zeros(1)
    # chuẩn hoá biên độ về [-0.9, 0.9] để tránh clipping
    peak = np.max(np.abs(sig)) + 1e-9
    sig = sig / peak * 0.9
    return sig.astype(np.float32)


def save_wav(sig, path, fs=FS):
    pcm = (sig * 32767).astype(np.int16)
    with wave.open(path, "w") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(fs)
        wf.writeframes(pcm.tobytes())


def play_wav(path):
    """Phát file wav bằng công cụ có sẵn của hệ điều hành (không cần thư viện ngoài)."""
    system = platform.system()
    try:
        if system == "Darwin":
            subprocess.run(["afplay", path])
        elif system == "Windows":
            import winsound
            winsound.PlaySound(path, winsound.SND_FILENAME)
        else:
            # Linux: thử aplay rồi paplay
            for player in ("aplay", "paplay"):
                try:
                    subprocess.run([player, path], check=True,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return
                except (FileNotFoundError, subprocess.CalledProcessError):
                    continue
            print(f"Không tìm thấy trình phát âm thanh hệ thống. File đã lưu tại: {path}")
    except Exception as e:
        print(f"Không thể phát âm thanh tự động ({e}). File wav đã lưu tại: {path}")


def play_letter(letter, f0=120, rate=1.0):
    sig = synth_letter(letter, f0=f0, rate=rate)
    tmp = os.path.join(tempfile.gettempdir(), f"letter_{letter}.wav")
    save_wav(sig, tmp)
    play_wav(tmp)
    return tmp


# ============================================================================
# PHẦN 4 — GIAO DIỆN TKINTER
# ============================================================================
def launch_gui():
    import tkinter as tk
    from tkinter import ttk
    import threading

    root = tk.Tk()
    root.title("Mô phỏng phát âm Alphabet — Tổng hợp âm thanh vật lý (Python)")
    root.configure(bg="#0f1117")
    root.geometry("760x560")

    title = tk.Label(root, text="🔊 Mô phỏng Alphabet bằng Tổng hợp Âm thanh Vật lý",
                      fg="#e8eaf0", bg="#0f1117", font=("Segoe UI", 15, "bold"))
    title.pack(pady=(14, 2))
    sub = tk.Label(root, text="Mô hình nguồn–lọc (Source-Filter) · Digital Resonator · numpy/scipy",
                   fg="#8b8fa3", bg="#0f1117", font=("Segoe UI", 10))
    sub.pack(pady=(0, 14))

    grid_frame = tk.Frame(root, bg="#0f1117")
    grid_frame.pack()

    f0_var = tk.IntVar(value=120)
    rate_var = tk.IntVar(value=100)

    status = tk.Label(root, text="", fg="#5b8cff", bg="#0f1117", font=("Segoe UI", 10))
    status.pack(pady=(6, 0))

    def on_click(letter, btn):
        def worker():
            status.config(text=f"Đang tổng hợp & phát âm chữ '{letter}'  /{IPA[letter]}/ ...")
            btn.configure(bg="#5b8cff", fg="white")
            try:
                play_letter(letter, f0=f0_var.get(), rate=rate_var.get() / 100)
            finally:
                btn.configure(bg="#1a1d27", fg="#e8eaf0")
                status.config(text=f"Đã phát chữ '{letter}'  /{IPA[letter]}/")
        threading.Thread(target=worker, daemon=True).start()

    letters = list(LETTERS.keys())
    cols = 7
    for idx, letter in enumerate(letters):
        r, c = divmod(idx, cols)
        btn = tk.Button(grid_frame, text=f"{letter}\n/{IPA[letter]}/",
                         width=8, height=3, bg="#1a1d27", fg="#e8eaf0",
                         activebackground="#3a5fd9", relief="flat",
                         font=("Segoe UI", 12, "bold"))
        btn.configure(command=lambda l=letter, b=btn: on_click(l, b))
        btn.grid(row=r, column=c, padx=5, pady=5)

    control = tk.Frame(root, bg="#0f1117")
    control.pack(pady=18)

    tk.Label(control, text="Cao độ giọng F0 (Hz):", fg="#e8eaf0", bg="#0f1117").grid(row=0, column=0, padx=6)
    tk.Scale(control, from_=80, to=260, orient="horizontal", variable=f0_var,
              bg="#0f1117", fg="#e8eaf0", troughcolor="#262b3c", highlightthickness=0,
              length=200).grid(row=0, column=1, padx=6)

    tk.Label(control, text="Tốc độ nói (%):", fg="#e8eaf0", bg="#0f1117").grid(row=0, column=2, padx=6)
    tk.Scale(control, from_=60, to=160, orient="horizontal", variable=rate_var,
              bg="#0f1117", fg="#e8eaf0", troughcolor="#262b3c", highlightthickness=0,
              length=200).grid(row=0, column=3, padx=6)

    footer = tk.Label(root,
        text="Bấm vào một chữ để nghe — file wav tạm được lưu và phát bằng trình phát hệ thống.",
        fg="#565b6f", bg="#0f1117", font=("Segoe UI", 9))
    footer.pack(pady=(4, 10))

    root.mainloop()


# ============================================================================
# ENTRY POINT
# ============================================================================
if __name__ == "__main__":
    args = [a.upper() for a in sys.argv[1:]]
    if args:
        # Chế độ dòng lệnh: tổng hợp & lưu wav cho các chữ được chỉ định
        out_dir = "letters_wav"
        os.makedirs(out_dir, exist_ok=True)
        for letter in args:
            if letter not in LETTERS:
                print(f"Bỏ qua '{letter}': không phải A-Z hợp lệ.")
                continue
            sig = synth_letter(letter)
            path = os.path.join(out_dir, f"{letter}.wav")
            save_wav(sig, path)
            print(f"Đã tạo {path}  (phát âm /{IPA[letter]}/)")
    else:
        launch_gui()
