# OpenBots on EC2 (or any VM with cloud-init)

[cloud-init.yaml](cloud-init.yaml) turns a fresh Ubuntu 24.04 instance into an OpenBots server running the compose stack, the hardened shape: every Bot's computer is its own container on the sandbox network, behind the Docker guard and the sandbox firewall. It installs Docker from Docker's apt repository, downloads one release's compose bundle, checks it against the release's `SHA256SUMS` and runs `install.sh --pair`. The same file works as user data on Hetzner, DigitalOcean and other providers that run cloud-init.

For what it costs, see [Amazon EC2's pricing page](https://aws.amazon.com/ec2/pricing/on-demand/) for a 2 vCPU, 4 GB instance (`t3.medium`, or `t4g.medium` on ARM) and 30 GB of `gp3` storage. Your model provider bills its usage separately.

## Launch

1. In `cloud-init.yaml`, set `OPENBOTS_RELEASE` to a release from the [Releases page](https://github.com/danielpang/OpenBots/releases) and `OPENBOTS_RELAY_URL` to the relay your phone goes through.
2. Make a security group with **no inbound rule**. With the relay, the server only dials out. Add port 22 from your own address only if you want `ssh`; Session Manager needs no inbound rule either.
3. Launch with IMDSv2 required and a hop limit of 1, so no container can read the instance's metadata service or its role credentials:

   ```sh
   aws ec2 run-instances \
     --image-id <Ubuntu 24.04 AMI> --instance-type t3.medium \
     --security-group-ids <the group> --key-name <your key> \
     --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=30,VolumeType=gp3}' \
     --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
     --user-data file://cloud-init.yaml
   ```

   In the console, the same settings are under Advanced details: Metadata version "V2 only" and Metadata response hop limit 1. Give the instance no IAM role unless something else on it needs one.

## Pair your phone

Setup takes a few minutes. When it is done, the QR code and the pairing link are in `/root/openbots-pair.txt` on the instance, readable by root only: `sudo cat /root/openbots-pair.txt` over `ssh` or Session Manager. They are kept out of the console log on purpose: on a server with no owner yet, whoever uses the code first becomes the owner, and anyone the account lets read the console log could.

A code works once and for 5 minutes, so the one from setup has often expired by the time you read it. Make a new one over `ssh` or Session Manager:

```sh
cd /opt/openbots/openbots-<release>
sudo docker compose run --rm openbots pair
```

On a server with no owner yet, the phone that pairs becomes the owner, so the instance needs no browser and no public address. Setup's log is in `/var/log/cloud-init-output.log`.

## Day two

From `/opt/openbots/openbots-<release>`, as root:

- **Status:** `docker compose ps`, `docker compose logs openbots`, `docker compose run --rm openbots relay`.
- **Upgrade:** the [README's Upgrade section](../../README.md#upgrade). Set `OPENBOTS_VERSION` in `.env` to the new release, then `docker compose pull && docker compose up -d`.
- **Backups:** the [README's Backup and restore section](../../README.md#backup-and-restore) (`scripts/backup.sh` and `scripts/restore.sh`). Copy the backups and `.env` (it holds the master key) off the instance. An EBS snapshot is the coarse alternative.
- **A public address:** for webhooks and connector sign-in, put a tunnel in front (the README's "Exposing your OpenBots server to the internet") rather than opening port 3000.
- **Your own relay:** on an instance with a public address, the compose stack's `relay` profile runs a relay beside it (the README's "Run OpenBots 24/7 on a VM").
