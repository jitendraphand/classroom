# Class capacity

The web app does not cap how many students can be in a class, and it does not cap how many classes can run at once. A student sees "This class is full." only when an administrator has set a positive **Students per class** value under System Control → Class size and microphones. The default is empty (no limit). The same page can limit how many student microphones are open at once; `0` means no microphone cap.

The rotating camera sample (at most six student cameras in the teacher's mosaic) is a bandwidth choice. It is not a class-size limit. Students who are not in the mosaic still attend, hear the class, and can be heard when the teacher unmutes them.

## What actually limits a server

LiveKit uses one UDP port per participant on a media node. This deployment's port range is **50000–60000** (about ten thousand ports). `room.max_participants` is **0** (unlimited) in `infra/livekit.example.yaml`, so the process does not reject a join before the ports run out.

When one machine is not enough, add media nodes the way [MULTI-SERVER.md](MULTI-SERVER.md) already describes. Each extra node brings its own UDP range. Do not raise a single node's port range past what the firewall allows.

Open the matching firewall range (see [DEPLOY-VPS.md](DEPLOY-VPS.md) and [DEPLOY-CADDY.md](DEPLOY-CADDY.md)):

```bash
sudo ufw allow 50000:60000/udp
```
