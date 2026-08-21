import { IntegrationError } from './errors.js';

export class ExactResourceAllowlist {
  private readonly resources: ReadonlySet<string>;

  public constructor(
    resources: readonly string[],
    private readonly resourceKind: string,
  ) {
    this.resources = new Set(resources.map(normalizeResource).filter(Boolean));
  }

  public has(resource: string): boolean {
    return this.resources.has(normalizeResource(resource));
  }

  public assertAllowed(resource: string): string {
    const approved = resource.trim().normalize('NFKC');
    const normalized = normalizeResource(approved);
    if (!normalized || !this.resources.has(normalized)) {
      throw new IntegrationError(
        'unauthorized',
        'RESOURCE_NOT_APPROVED',
        `${this.resourceKind} is not approved for this integration.`,
        false,
      );
    }
    return approved;
  }

  public get size(): number {
    return this.resources.size;
  }
}

function normalizeResource(resource: string): string {
  return resource.trim().normalize('NFKC').toLowerCase();
}
