import type { Metadata } from 'next';
import './style.css';
export const metadata:Metadata={title:'XYX on Monad — Evidence before settlement',description:'Live proof of agent work and protected USDC settlement on Monad.'};
export default function Layout({children}:{children:React.ReactNode}){
  return <html lang="en"><body>{children}</body></html>;
}
