"""列出所有 WASAPI 音频端点，标注输入/输出，方便选虚拟声卡与麦克风。"""
import sounddevice as sd

print("sounddevice", sd.__version__)
for host_idx, host in enumerate(sd.query_hostapis()):
    print(f"\n=== hostapi {host_idx}: {host['name']} ===")
    for dev_idx in host["devices"]:
        d = sd.query_devices(dev_idx)
        kind = []
        if d["max_input_channels"]:
            kind.append(f"IN{d['max_input_channels']}")
        if d["max_output_channels"]:
            kind.append(f"OUT{d['max_output_channels']}")
        print(f"{dev_idx:>3}  {d['name'][:48]:<50} {'/'.join(kind):<10} sr={int(d['default_samplerate'])}")

print("\n默认输入:", sd.query_devices(kind="input")["name"])
print("默认输出:", sd.query_devices(kind="output")["name"])
