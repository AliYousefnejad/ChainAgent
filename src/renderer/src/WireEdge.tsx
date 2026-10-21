import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type Edge, type EdgeProps } from '@xyflow/react'

// toShell: wires into a Shell paste commands, and only press Enter when autoRun is on.
export type WireData = { toShell?: boolean; autoRun?: boolean; status?: string }
export type WireEdgeType = Edge<WireData, 'wire'>

export default function WireEdge(props: EdgeProps<WireEdgeType>) {
  const { id, data, style, markerEnd } = props
  const { updateEdgeData } = useReactFlow()
  const [path, labelX, labelY] = getBezierPath(props)
  const showLabel = data?.toShell || data?.status

  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {showLabel && (
        <EdgeLabelRenderer>
          <div
            className="wire-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data?.status && <span className="wire-status">{data.status}</span>}
            {data?.toShell && (
              <button
                className={data.autoRun ? 'wire-autorun on' : 'wire-autorun'}
                title={data.autoRun ? 'Commands run as soon as they arrive' : 'Commands are pasted; you press Enter'}
                onClick={() => updateEdgeData(id, { autoRun: !data.autoRun })}
              >
                Auto-run: {data.autoRun ? 'on' : 'off'}
              </button>
            )}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}
