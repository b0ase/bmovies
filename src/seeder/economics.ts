/**
 * Seeder economics — tracks revenue per content, per peer.
 */

export interface EarningsRecord {
  infohash: string;
  title: string;
  piecesServed: number;
  seederEarnings: number;
  creatorPayments: number;
  totalRevenue: number;
  activeChannels: number;
}

export class Economics {
  private earnings = new Map<
    string,
    { title: string; piecesServed: number; seederEarnings: number; creatorPayments: number; activeChannels: number }
  >();

  /** Record a piece payment */
  recordPayment(
    infohash: string,
    title: string,
    seederAmount: number,
    creatorAmount: number,
  ): void {
    const existing = this.earnings.get(infohash) ?? {
      title,
      piecesServed: 0,
      seederEarnings: 0,
      creatorPayments: 0,
      activeChannels: 0,
    };

    existing.piecesServed++;
    existing.seederEarnings += seederAmount;
    existing.creatorPayments += creatorAmount;
    this.earnings.set(infohash, existing);
  }

  /** Update active channel count for content */
  setActiveChannels(infohash: string, count: number): void {
    const existing = this.earnings.get(infohash);
    if (existing) existing.activeChannels = count;
  }

  /** Get earnings for a specific content */
  getEarnings(infohash: string): EarningsRecord | undefined {
    const e = this.earnings.get(infohash);
    if (!e) return undefined;
    return {
      infohash,
      ...e,
      totalRevenue: e.seederEarnings + e.creatorPayments,
    };
  }

  /** Get all earnings */
  getAllEarnings(): EarningsRecord[] {
    return [...this.earnings.entries()].map(([infohash, e]) => ({
      infohash,
      ...e,
      totalRevenue: e.seederEarnings + e.creatorPayments,
    }));
  }

  /** Total seeder earnings across all content */
  get totalSeederEarnings(): number {
    let total = 0;
    for (const e of this.earnings.values()) total += e.seederEarnings;
    return total;
  }

  /** Total pieces served across all content */
  get totalPiecesServed(): number {
    let total = 0;
    for (const e of this.earnings.values()) total += e.piecesServed;
    return total;
  }
}
