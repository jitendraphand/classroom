import time, json, sys, numpy as np, soundfile as sf, torch
from scipy.signal import resample_poly, lfilter, butter
from pesq import pesq
from df.enhance import enhance, init_df
torch.set_num_threads(1)
rng = np.random.default_rng(7)
def load(p, sr=48000):
    x, s = sf.read(p, dtype='float32')
    if x.ndim > 1: x = x.mean(1)
    from math import gcd
    g = gcd(s, sr); x = resample_poly(x, sr//g, s//g).astype(np.float32)
    return x / (np.abs(x).max() + 1e-9) * 0.5
clean = np.concatenate([load('/workspace/live-test-20261017/osr11.wav'), load('/workspace/live-test-20261017/osr31.wav')])[:48000*30]
N = len(clean)
def pink(n):
    w = rng.standard_normal(n); b=[0.049922035,-0.095993537,0.050612699,-0.004408786]; a=[1,-2.494956002,2.017265875,-0.522189400]
    return lfilter(b,a,w)
def fan(n):
    b,a = butter(2, 400/24000); return lfilter(b,a,rng.standard_normal(n))*3 + 0.2*np.sin(2*np.pi*120*np.arange(n)/48000)
def hum(n):
    t=np.arange(n)/48000; return sum(np.sin(2*np.pi*50*k*t)/k for k in range(1,8))
def clicks(n):
    x=np.zeros(n); idx=rng.integers(0,n-500,size=n//4800*3)
    for i in idx: x[i:i+300]+=rng.standard_normal(300)*np.exp(-np.arange(300)/40)
    return x + 0.05*rng.standard_normal(n)
noises = {'white': lambda n: rng.standard_normal(n), 'pink': pink, 'fan': fan, 'hum': hum, 'keyboard': clicks}
def mix(c, nz, snr):
    nz = nz/ (np.sqrt(np.mean(nz**2))+1e-12) * np.sqrt(np.mean(c**2)) / (10**(snr/20))
    return (c+nz).astype(np.float32)
def snr_db(ref, x):
    a = np.dot(x, ref)/np.dot(ref, ref); e = x - a*ref
    return 10*np.log10(np.sum((a*ref)**2)/(np.sum(e**2)+1e-12))
def p16(ref, x):
    return pesq(16000, resample_poly(ref,1,3), resample_poly(x,1,3), 'wb')
model, st, _ = init_df()
rows=[]; tproc=0; tdur=0
for name, f in noises.items():
    for snr in (0,5,10):
        noisy = mix(clean, f(N), snr)
        t0=time.perf_counter()
        out = enhance(model, st, torch.from_numpy(noisy)[None]).squeeze().numpy()
        tproc += time.perf_counter()-t0; tdur += N/48000
        out = out[:N]
        rows.append(dict(noise=name, snr_in=snr, pesq_raw=round(p16(clean,noisy),2), pesq_dfn=round(p16(clean,out),2), snr_raw=round(snr_db(clean,noisy),1), snr_dfn=round(snr_db(clean,out),1)))
        print(rows[-1], flush=True)
# clean speech must not be damaged
out = enhance(model, st, torch.from_numpy(clean.astype(np.float32))[None]).squeeze().numpy()[:N]
rows.append(dict(noise='none', snr_in=None, pesq_raw=round(p16(clean,clean),2), pesq_dfn=round(p16(clean,out),2)))
print(rows[-1])
print('RTF_1thread', round(tproc/tdur,3))
json.dump(dict(rows=rows, rtf_1thread=tproc/tdur, arch=__import__('platform').machine()), open('/workspace/dfn-eval/results.json','w'), indent=1)
