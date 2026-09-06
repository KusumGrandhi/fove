/** Vite's ?worker imports return a Worker constructor. */
declare module "*?worker" {
  const WorkerFactory: new () => Worker;
  export default WorkerFactory;
}
