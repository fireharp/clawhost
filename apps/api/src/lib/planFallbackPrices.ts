import type { ProviderType } from '@/ts/Types'

const planFallbackPrices: Record<ProviderType, Record<string, number>> = {
    hetzner: {
        cx23: 10,
        cx33: 15,
        cx43: 20,
        cx53: 30,
        cpx11: 15,
        cpx21: 20,
        cpx31: 30,
        cpx41: 50,
        cpx51: 75,
        cax11: 10,
        cax21: 15,
        cax31: 25,
        cax41: 50,
        ccx13: 25,
        ccx23: 50,
        ccx33: 100,
        ccx43: 150,
        ccx53: 250,
        ccx63: 350
    },
    digitalocean: {
        's-1vcpu-512mb-10gb': 10,
        's-1vcpu-1gb': 15,
        's-1vcpu-2gb': 20,
        's-2vcpu-2gb': 30,
        's-2vcpu-4gb': 50,
        's-4vcpu-8gb': 75,
        's-8vcpu-16gb': 150
    },
    vultr: {
        'vc2-1c-1gb': 10,
        'vc2-1c-2gb': 20,
        'vc2-2c-2gb': 30,
        'vc2-2c-4gb': 40,
        'vc2-4c-8gb': 80,
        'vc2-6c-16gb': 160,
        'vc2-8c-32gb': 320,
        'vc2-16c-64gb': 500,
        'vhp-1c-1gb-amd': 12,
        'vhp-1c-2gb-amd': 24,
        'vhp-2c-2gb-amd': 32,
        'vhp-2c-4gb-amd': 48,
        'vhp-4c-8gb-amd': 120,
        'vhp-4c-12gb-amd': 180,
        'vhp-8c-16gb-amd': 192,
        'vhp-12c-24gb-amd': 250,
        'vhf-1c-2gb': 24,
        'vhf-2c-4gb': 48,
        'vhf-3c-8gb': 96,
        'vhf-4c-16gb': 125,
        'vhf-8c-32gb': 192,
        'vhf-12c-48gb': 500
    },
    gcp: {
        'e2-small': 15,
        'e2-medium': 25,
        'e2-standard-2': 50,
        'e2-standard-4': 100,
        'e2-standard-8': 200,
        'e2-standard-16': 400
    }
}

export default planFallbackPrices