/**
 * Identity internals.
 *
 * Identity may import `shared` and nothing else. It is deliberately the most
 * constrained domain here: the one every other domain would like to reach into
 * "just for the customer name" is exactly the one worth fencing off.
 */

export type Customer = {
  id: string;
  displayName: string;
};

const CUSTOMERS: readonly Customer[] = [
  { id: 'c-1', displayName: 'Ada Lovelace' },
  { id: 'c-2', displayName: 'Grace Hopper' },
];

/** Look up one customer, or undefined when the id is unknown. */
export function findCustomer(id: string): Customer | undefined {
  return CUSTOMERS.find((customer) => customer.id === id);
}
