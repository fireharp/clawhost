import type {
    CloudProvider,
    CreateServerResult,
    CreateSSHKeyResult,
    DatacenterAvailability,
    LocationInfo,
    RawServerType,
    ServerStatus,
    ServerTypeInfo,
    VolumeDetails,
    VolumeInfo,
    VolumePricingResult
} from '@/ts/Interfaces'

import crypto from 'crypto'
import type { protos } from '@google-cloud/compute'

import {
    DisksClient,
    FirewallsClient,
    GlobalOperationsClient,
    InstancesClient,
    ProjectsClient,
    RegionsClient,
    ZoneOperationsClient,
    ZonesClient
} from '@google-cloud/compute'

import { clawStatus } from '@openclaw/shared'

const FIREWALL_NAME = 'openclaw-allow-web'
const NETWORK_TAG = 'openclaw-server'
const UBUNTU_IMAGE_FAMILY =
    'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64'

const PLAN_SPECS: Record<
    string,
    {
        cores: number
        memory: number
        disk: number
        description: string
        priceMonthly: number
    }
> = {
    'e2-small': {
        cores: 2,
        memory: 2,
        disk: 20,
        description: 'E2 Small',
        priceMonthly: 15
    },
    'e2-medium': {
        cores: 2,
        memory: 4,
        disk: 40,
        description: 'E2 Medium',
        priceMonthly: 25
    },
    'e2-standard-2': {
        cores: 2,
        memory: 8,
        disk: 80,
        description: 'E2 Standard 2',
        priceMonthly: 50
    },
    'e2-standard-4': {
        cores: 4,
        memory: 16,
        disk: 80,
        description: 'E2 Standard 4',
        priceMonthly: 100
    },
    'e2-standard-8': {
        cores: 8,
        memory: 32,
        disk: 160,
        description: 'E2 Standard 8',
        priceMonthly: 200
    },
    'e2-standard-16': {
        cores: 16,
        memory: 64,
        disk: 320,
        description: 'E2 Standard 16',
        priceMonthly: 400
    }
}

const PLAN_ORDER = [
    'e2-small',
    'e2-medium',
    'e2-standard-2',
    'e2-standard-4',
    'e2-standard-8',
    'e2-standard-16'
] as const

const getProjectId = (): string => {
    const id = process.env.GCP_PROJECT_ID
    if (!id) {
        throw new Error('GCP_PROJECT_ID is not set')
    }
    return id
}

const sshFingerprint = (publicKey: string): string => {
    const keyBody = publicKey.trim().split(/\s+/)[1]
    if (!keyBody) {
        return crypto.createHash('md5').update(publicKey).digest('hex')
    }
    const buf = Buffer.from(keyBody, 'base64')
    const hash = crypto.createHash('md5').update(buf).digest('hex')
    return hash.match(/.{2}/g)?.join(':') ?? hash
}

const parseInstanceRef = (ref: string): { zone: string; name: string } => {
    const i = ref.indexOf('/')
    if (i <= 0 || i === ref.length - 1) {
        throw new Error('Invalid GCP instance ref')
    }
    return { zone: ref.slice(0, i), name: ref.slice(i + 1) }
}

const parseVolumeRef = (ref: string): { zone: string; diskName: string } => {
    const parsed = parseInstanceRef(ref)
    return { zone: parsed.zone, diskName: parsed.name }
}

const mapGcpStatus = (s: string | null | undefined): string => {
    const v = (s || '').toUpperCase()
    const statusMap: Record<string, string> = {
        STAGING: clawStatus.initializing,
        PROVISIONING: clawStatus.initializing,
        RUNNING: clawStatus.running,
        STOPPING: clawStatus.stopped,
        STOPPED: clawStatus.stopped,
        SUSPENDING: clawStatus.stopped,
        SUSPENDED: clawStatus.stopped,
        TERMINATED: clawStatus.stopped
    }
    return statusMap[v] || clawStatus.initializing
}

const getExternalIp = (
    inst: protos.google.cloud.compute.v1.IInstance | null | undefined
): string => {
    const ni = inst?.networkInterfaces?.[0]
    const ac = ni?.accessConfigs?.[0]
    return ac?.natIP || ''
}

const pickZone = async (
    zonesClient: ZonesClient,
    project: string,
    region: string
): Promise<string> => {
    const [zones] = await zonesClient.list({ project })
    const items = zones.filter(
        (z: protos.google.cloud.compute.v1.IZone) =>
            z.status === 'UP' &&
            typeof z.name === 'string' &&
            z.name.startsWith(`${region}-`)
    )
    if (!items.length || !items[0].name) {
        throw new Error(`No available zone for region ${region}`)
    }
    return items[0].name
}

let firewallEnsured = false

const ensureFirewall = async (
    project: string,
    firewallsClient: FirewallsClient,
    globalOps: GlobalOperationsClient
): Promise<void> => {
    if (firewallEnsured) return
    const [firewalls] = await firewallsClient.list({ project })
    const exists = firewalls.some(
        (f: protos.google.cloud.compute.v1.IFirewall) =>
            f.name === FIREWALL_NAME
    )
    if (exists) {
        firewallEnsured = true
        return
    }
    const [fwOp] = await firewallsClient.insert({
        project,
        firewallResource: {
            name: FIREWALL_NAME,
            network: 'global/networks/default',
            direction: 'INGRESS',
            priority: 1000,
            allowed: [{ IPProtocol: 'tcp', ports: ['22', '80', '443'] }],
            sourceRanges: ['0.0.0.0/0'],
            targetTags: [NETWORK_TAG]
        }
    })
    if (fwOp?.name) {
        await globalOps.wait({ project, operation: fwOp.name })
    }
    firewallEnsured = true
}

const gcp: CloudProvider = {
    async createServer(
        name: string,
        serverType: string,
        location: string,
        rootPassword?: string,
        _sshKeyIds?: number[],
        _snapshotId?: string,
        userData?: string
    ): Promise<CreateServerResult> {
        const project = getProjectId()
        const instancesClient = new InstancesClient()
        const zoneOps = new ZoneOperationsClient()
        const zonesClient = new ZonesClient()
        const firewallsClient = new FirewallsClient()
        const globalOps = new GlobalOperationsClient()

        await ensureFirewall(project, firewallsClient, globalOps)

        const zone = await pickZone(zonesClient, project, location)
        const spec = PLAN_SPECS[serverType]
        const diskGb = spec?.disk ?? 20

        const metadataItems: Array<{ key: string; value: string }> = []
        if (userData) {
            metadataItems.push({ key: 'user-data', value: userData })
        }

        const [insertOp] = await instancesClient.insert({
            project,
            zone,
            instanceResource: {
                name,
                machineType: `zones/${zone}/machineTypes/${serverType}`,
                disks: [
                    {
                        boot: true,
                        autoDelete: true,
                        initializeParams: {
                            sourceImage: UBUNTU_IMAGE_FAMILY,
                            diskSizeGb: String(diskGb),
                            diskType: `zones/${zone}/diskTypes/pd-standard`
                        }
                    }
                ],
                networkInterfaces: [
                    {
                        network: 'global/networks/default',
                        accessConfigs: [
                            {
                                name: 'External NAT',
                                type: 'ONE_TO_ONE_NAT'
                            }
                        ]
                    }
                ],
                tags: { items: [NETWORK_TAG] },
                metadata: { items: metadataItems }
            }
        })

        if (!insertOp?.name) {
            throw new Error('GCP instance insert did not return an operation')
        }
        await zoneOps.wait({ project, zone, operation: insertOp.name })

        let ip = ''
        for (let i = 0; i < 30; i++) {
            const [inst] = await instancesClient.get({
                project,
                zone,
                instance: name
            })
            ip = getExternalIp(inst)
            if (ip) break
            await new Promise((r) => setTimeout(r, 2000))
        }

        const ref = `${zone}/${name}`
        return {
            serverId: 0,
            ip,
            rootPassword: rootPassword || '',
            providerServerId: ref
        }
    },

    async getServer(serverId: string): Promise<ServerStatus> {
        const project = getProjectId()
        const { zone, name } = parseInstanceRef(serverId)
        const instancesClient = new InstancesClient()
        const [inst] = await instancesClient.get({
            project,
            zone,
            instance: name
        })
        return {
            status: mapGcpStatus(inst.status),
            ip: getExternalIp(inst)
        }
    },

    async getServers(): Promise<Map<string, ServerStatus>> {
        const project = getProjectId()
        const instancesClient = new InstancesClient()
        const result = new Map<string, ServerStatus>()
        const iterable = instancesClient.aggregatedListAsync({ project })
        for await (const [key, scoped] of iterable) {
            if (!key.startsWith('zones/')) continue
            const zone = key.replace('zones/', '')
            const list = scoped.instances ?? []
            for (const inst of list) {
                if (!inst.name) continue
                const ref = `${zone}/${inst.name}`
                result.set(ref, {
                    status: mapGcpStatus(inst.status),
                    ip: getExternalIp(inst)
                })
            }
        }
        return result
    },

    async startServer(serverId: string): Promise<void> {
        const project = getProjectId()
        const { zone, name } = parseInstanceRef(serverId)
        const instancesClient = new InstancesClient()
        const zoneOps = new ZoneOperationsClient()
        const [op] = await instancesClient.start({
            project,
            zone,
            instance: name
        })
        if (op?.name) {
            await zoneOps.wait({ project, zone, operation: op.name })
        }
    },

    async stopServer(serverId: string): Promise<void> {
        const project = getProjectId()
        const { zone, name } = parseInstanceRef(serverId)
        const instancesClient = new InstancesClient()
        const zoneOps = new ZoneOperationsClient()
        const [op] = await instancesClient.stop({
            project,
            zone,
            instance: name
        })
        if (op?.name) {
            await zoneOps.wait({ project, zone, operation: op.name })
        }
    },

    async restartServer(serverId: string): Promise<void> {
        const project = getProjectId()
        const { zone, name } = parseInstanceRef(serverId)
        const instancesClient = new InstancesClient()
        const zoneOps = new ZoneOperationsClient()
        const [op] = await instancesClient.reset({
            project,
            zone,
            instance: name
        })
        if (op?.name) {
            await zoneOps.wait({ project, zone, operation: op.name })
        }
    },

    async deleteServer(serverId: string): Promise<void> {
        const project = getProjectId()
        const { zone, name } = parseInstanceRef(serverId)
        const instancesClient = new InstancesClient()
        const zoneOps = new ZoneOperationsClient()
        const [op] = await instancesClient.delete({
            project,
            zone,
            instance: name
        })
        if (op?.name) {
            await zoneOps.wait({ project, zone, operation: op.name })
        }
    },

    async getServerTypes(): Promise<ServerTypeInfo[]> {
        return [...PLAN_ORDER].map((planName) => {
            const s = PLAN_SPECS[planName]
            return {
                name: planName,
                description: s.description,
                cores: s.cores,
                memory: s.memory,
                disk: s.disk,
                architecture: 'x86',
                priceHourly: s.priceMonthly / 730,
                priceMonthly: s.priceMonthly
            }
        })
    },

    async getLocations(): Promise<LocationInfo[]> {
        const project = getProjectId()
        const regionsClient = new RegionsClient()
        const [regions] = await regionsClient.list({ project })
        return regions
            .filter(
                (r: protos.google.cloud.compute.v1.IRegion) =>
                    r.status === 'UP' && r.name
            )
            .map((r: protos.google.cloud.compute.v1.IRegion) => {
                const id = r.name as string
                return {
                    id,
                    name: r.description || id,
                    city: id,
                    country: '',
                    disabled: false
                }
            })
    },

    async getRawServerTypes(): Promise<RawServerType[]> {
        return [...PLAN_ORDER].map((name, i) => ({ id: i + 1, name }))
    },

    async getDatacenters(): Promise<DatacenterAvailability[]> {
        const project = getProjectId()
        const regionsClient = new RegionsClient()
        const [regions] = await regionsClient.list({ project })
        const items = regions.filter(
            (r: protos.google.cloud.compute.v1.IRegion) =>
                r.status === 'UP' && r.name
        )
        const typeIds = [...PLAN_ORDER].map((_, i) => i + 1)
        return items.map((r: protos.google.cloud.compute.v1.IRegion) => {
            const id = r.name as string
            return {
                name: id,
                locationName: id,
                availableServerTypeIds: [...typeIds]
            }
        })
    },

    async createSSHKey(
        name: string,
        publicKey: string
    ): Promise<CreateSSHKeyResult> {
        const project = getProjectId()
        const projectsClient = new ProjectsClient()
        const globalOps = new GlobalOperationsClient()

        const markerId = Math.floor(Math.random() * 2_000_000_000) + 1
        const line = `root:${publicKey.trim()} #clawk:${markerId}`

        const [proj] = await projectsClient.get({ project })
        const meta = proj.commonInstanceMetadata
        const items = [...(meta?.items ?? [])]
        const sshIdx = items.findIndex((it) => it.key === 'ssh-keys')
        const prev = sshIdx >= 0 ? (items[sshIdx].value ?? '') : ''
        const nextVal = prev ? `${prev}\n${line}` : line
        if (sshIdx >= 0) {
            items[sshIdx] = { key: 'ssh-keys', value: nextVal }
        } else {
            items.push({ key: 'ssh-keys', value: nextVal })
        }

        const [op] = await projectsClient.setCommonInstanceMetadata({
            project,
            metadataResource: {
                items,
                fingerprint: meta?.fingerprint
            }
        })
        if (op?.name) {
            await globalOps.wait({ project, operation: op.name })
        }

        return {
            id: markerId,
            name,
            fingerprint: sshFingerprint(publicKey)
        }
    },

    async deleteSSHKey(keyId: number): Promise<void> {
        const project = getProjectId()
        const projectsClient = new ProjectsClient()
        const globalOps = new GlobalOperationsClient()
        const marker = `#clawk:${keyId}`

        const [proj] = await projectsClient.get({ project })
        const meta = proj.commonInstanceMetadata
        const items = [...(meta?.items ?? [])]
        const sshIdx = items.findIndex((it) => it.key === 'ssh-keys')
        if (sshIdx < 0) return
        const val = items[sshIdx].value ?? ''
        const lines = val
            .split('\n')
            .filter((ln) => ln && !ln.includes(marker))
            .join('\n')
        items[sshIdx] = { key: 'ssh-keys', value: lines }

        const [op] = await projectsClient.setCommonInstanceMetadata({
            project,
            metadataResource: {
                items,
                fingerprint: meta?.fingerprint
            }
        })
        if (op?.name) {
            await globalOps.wait({ project, operation: op.name })
        }
    },

    async getVolumePricing(): Promise<VolumePricingResult> {
        return { pricePerGbMonthly: 0.04 }
    },

    async createVolume(
        diskName: string,
        size: number,
        location: string,
        _serverId?: number,
        attachInstanceRef?: string
    ): Promise<VolumeInfo> {
        const project = getProjectId()
        const zonesClient = new ZonesClient()
        const disksClient = new DisksClient()
        const instancesClient = new InstancesClient()
        const zoneOps = new ZoneOperationsClient()

        const zone = await pickZone(zonesClient, project, location)

        const [diskOp] = await disksClient.insert({
            project,
            zone,
            diskResource: {
                name: diskName,
                sizeGb: String(size),
                type: `zones/${zone}/diskTypes/pd-standard`
            }
        })
        if (!diskOp?.name) {
            throw new Error('GCP disk insert failed')
        }
        await zoneOps.wait({ project, zone, operation: diskOp.name })

        const ref = `${zone}/${diskName}`

        if (attachInstanceRef) {
            const { zone: iz, name: iname } =
                parseInstanceRef(attachInstanceRef)
            if (iz !== zone) {
                throw new Error('GCP volume zone must match instance zone')
            }
            const deviceName = diskName
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '-')
                .slice(0, 63)
            const diskUrl = `projects/${project}/zones/${zone}/disks/${diskName}`
            const [attOp] = await instancesClient.attachDisk({
                project,
                zone: iz,
                instance: iname,
                attachedDiskResource: {
                    source: diskUrl,
                    deviceName,
                    autoDelete: false,
                    mode: 'READ_WRITE'
                }
            })
            if (attOp?.name) {
                await zoneOps.wait({ project, zone: iz, operation: attOp.name })
            }
        }

        return {
            id: 0,
            size,
            location,
            ref
        }
    },

    async attachVolume(volumeId: number, serverId: number): Promise<void> {
        void volumeId
        void serverId
    },

    async detachVolume(volumeId: number, resourceRef?: string): Promise<void> {
        void volumeId
        const project = getProjectId()
        const disksClient = new DisksClient()
        const instancesClient = new InstancesClient()
        const zoneOps = new ZoneOperationsClient()
        if (!resourceRef) return
        const { zone, diskName } = parseVolumeRef(resourceRef)
        const [disk] = await disksClient.get({ project, zone, disk: diskName })
        const userUrl = disk.users?.[0]
        if (!userUrl || typeof userUrl !== 'string') return
        const match = userUrl.match(/\/zones\/([^/]+)\/instances\/([^/]+)$/)
        if (!match) return
        const iz = match[1]
        const iname = match[2]
        const [inst] = await instancesClient.get({
            project,
            zone: iz,
            instance: iname
        })
        const attached = inst.disks?.find((d) =>
            d.source?.endsWith(`/disks/${diskName}`)
        )
        const dev = attached?.deviceName
        if (!dev) return
        const [op] = await instancesClient.detachDisk({
            project,
            zone: iz,
            instance: iname,
            deviceName: dev
        })
        if (op?.name) {
            await zoneOps.wait({ project, zone: iz, operation: op.name })
        }
    },

    async deleteVolume(volumeId: number, resourceRef?: string): Promise<void> {
        void volumeId
        const project = getProjectId()
        if (!resourceRef) return
        const { zone, diskName } = parseVolumeRef(resourceRef)
        const disksClient = new DisksClient()
        const zoneOps = new ZoneOperationsClient()
        const [op] = await disksClient.delete({
            project,
            zone,
            disk: diskName
        })
        if (op?.name) {
            await zoneOps.wait({ project, zone, operation: op.name })
        }
    },

    async getVolume(volumeId: number): Promise<VolumeDetails> {
        void volumeId
        return {
            id: 0,
            size: 0,
            status: 'unknown',
            serverId: null
        }
    }
}

export default gcp